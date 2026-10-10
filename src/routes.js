const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { requireUser } = require('./auth');
const { HttpError } = require('./errors');
const { isPdf, extractPages, chunkPages } = require('./pdf');

const MAX_SOURCES = 3;
const NEAREST_CHUNKS = 6;
const MAX_RELEVANT_DISTANCE = 0.65; // cosine distance; larger means "not really related"

// Builds the /api router. Services are passed in so tests can use fakes.
function createRoutes({ config, verifyIdToken, store, ai, files }) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxPdfBytes, files: 1 },
  });

  // Per-student limits (AI calls cost money).
  const limitPerUser = (limit, message) => rateLimit({
    windowMs: 60 * 1000,
    limit,
    keyGenerator: (req) => req.user.uid,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });

  router.use(requireUser(verifyIdToken));

  router.post('/doubts/ask', limitPerUser(20, 'Too many questions. Please wait a minute.'), async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) throw new HttpError(400, 'Please type your doubt.');
    if (question.length > config.maxQuestionLength) {
      throw new HttpError(400, `Please keep your doubt under ${config.maxQuestionLength} characters.`);
    }

    const requestedId = req.body?.conversationId;
    let conversationId = typeof requestedId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(requestedId) ? requestedId : null;
    const uid = req.user.uid;

    const [vector, history] = await Promise.all([
      ai.embedQuery(question),
      conversationId ? store.conversationHistory(uid, conversationId, 4) : [],
    ]);
    const chunks = (await store.nearestChunks(uid, vector, NEAREST_CHUNKS))
      .filter((c) => c.distance === undefined || c.distance <= MAX_RELEVANT_DISTANCE);

    const result = await ai.answerQuestion({ question, chunks, history });
    if (!result.answer) throw new HttpError(502, "DoubtBuddy couldn't answer that. Please try rephrasing.");

    const sources = [];
    for (const id of result.sourceIds) {
      const chunk = chunks[id];
      if (!chunk || sources.some((s) => s.fileName === chunk.fileName && s.page === chunk.page)) continue;
      sources.push({ fileName: chunk.fileName, page: chunk.page });
      if (sources.length === MAX_SOURCES) break;
    }

    conversationId = conversationId || crypto.randomUUID().replace(/-/g, '');
    const saved = await store.saveDoubt(uid, { question, answer: result.answer, sources, conversationId });

    res.json({ answer: result.answer, sources, conversationId, doubtId: saved.id });
  });

  router.get('/doubts/recent', async (req, res) => {
    const limit = clampInt(req.query.limit, 1, 50, 20);
    const items = await store.recentDoubts(req.user.uid, limit);
    res.json({ items });
  });

  router.post('/notes/upload', limitPerUser(5, 'Too many uploads. Please wait a minute.'), upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, "Please attach a PDF in the 'file' field.");
    if (!isPdf(req.file.buffer)) throw new HttpError(400, "That file isn't a valid PDF.");

    const fileName = cleanFileName(req.file.originalname);
    const pages = await extractPages(req.file.buffer, config.maxPdfPages);
    const chunks = chunkPages(pages);
    if (!chunks.length) {
      throw new HttpError(400, 'No readable text found. Scanned/photo PDFs are not supported yet - please use a text-based PDF.');
    }

    const uid = req.user.uid;
    const noteId = store.newNoteId(uid);
    const storagePath = files ? `users/${uid}/notes/${noteId}.pdf` : null;

    const [embeddings] = await Promise.all([
      ai.embedDocuments(chunks.map((c) => c.text)),
      files ? files.save(storagePath, req.file.buffer, 'application/pdf') : null,
    ]);
    chunks.forEach((chunk, i) => { chunk.embedding = embeddings[i]; });

    await store.saveNote(uid, { id: noteId, fileName, pageCount: pages.length, storagePath }, chunks);
    res.status(201).json({ noteId, fileName, pageCount: pages.length });
  });

  router.get('/quiz', limitPerUser(6, 'Too many quizzes. Please wait a minute.'), async (req, res) => {
    const count = clampInt(req.query.count, 1, config.maxQuizQuestions, 10);
    const chunks = await store.sampleChunks(req.user.uid, 12);
    if (!chunks.length) throw new HttpError(400, 'Upload some notes first, then DoubtBuddy can make a quiz from them.');

    const questions = await ai.generateQuiz({ chunks, count });
    if (!questions.length) throw new HttpError(502, "Couldn't create a quiz right now. Please try again.");
    res.json({ questions });
  });

  return router;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

function cleanFileName(name) {
  // multer may give latin1-decoded names; re-decode so non-English names survive.
  const raw = name || 'notes.pdf';
  const redecoded = /[^\u0000-ÿ]/.test(raw) ? raw : Buffer.from(raw, 'latin1').toString('utf8');
  const decoded = redecoded.includes('�') ? raw : redecoded;
  const base = path.basename(decoded).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').trim();
  return (base || 'notes.pdf').slice(0, 120);
}

module.exports = { createRoutes };
