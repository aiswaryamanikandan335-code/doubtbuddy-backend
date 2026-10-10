const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

// A tiny real PDF with one page of text, so the pdfjs extraction path is exercised.
// Text is wrapped into short lines: text running off the page edge is not extracted.
function makePdf(text) {
  const lines = text.match(/.{1,60}(\s|$)/g).map((l) => `(${l.trim()}) Tj T*`).join(' ');
  const stream = `BT /F1 12 Tf 16 TL 72 720 Td ${lines} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function setup(options = {}) {
  const db = { chunks: [], doubts: [], notes: [], files: [] };
  const services = {
    config: { maxPdfBytes: 1024 * 1024, maxPdfPages: 50, maxQuestionLength: 1000, maxQuizQuestions: 15 },
    verifyIdToken: async (token) => {
      if (token !== 'good-token') throw new Error('bad token');
      return { uid: 'student1', email: 's@example.com' };
    },
    files: { save: async (filePath) => { db.files.push(filePath); } },
    ai: {
      embedQuery: async () => [0.1, 0.2],
      embedDocuments: async (texts) => texts.map(() => [0.1, 0.2]),
      answerQuestion: async ({ chunks }) => ({ answer: 'Plants make food from light.', sourceIds: chunks.length ? [0, 0] : [] }),
      generateQuiz: async ({ count }) => Array.from({ length: count }, (_, i) => ({
        question: `Q${i}`, options: ['a', 'b', 'c', 'd'], correctIndex: 1, explanation: 'because',
      })),
    },
    store: {
      newNoteId: () => 'note1',
      saveNote: async (uid, note, chunks) => { db.notes.push(note); db.chunks.push(...chunks.map((c) => ({ ...c, fileName: note.fileName }))); },
      nearestChunks: async () => db.chunks.map((c) => ({ ...c, distance: 0.2 })),
      sampleChunks: async () => db.chunks,
      saveDoubt: async (uid, doubt) => { db.doubts.push(doubt); return { id: `d${db.doubts.length}` }; },
      recentDoubts: async () => db.doubts.map((d, i) => ({ id: `d${i + 1}`, ...d, createdAt: '2026-10-10T08:00:00.000Z' })),
      conversationHistory: async () => [],
    },
  };
  if ('files' in options) services.files = options.files;
  Object.assign(services.ai, options.aiOverrides);
  return { app: createApp(services), db };
}

const auth = { Authorization: 'Bearer good-token' };

test('rejects requests without a valid Firebase token', async () => {
  const { app } = setup();
  const missing = await request(app).get('/api/doubts/recent');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, 'Please sign in.');

  const bad = await request(app).get('/api/doubts/recent').set('Authorization', 'Bearer nope');
  assert.equal(bad.status, 401);
});

test('health check is public', async () => {
  const { app } = setup();
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
});

test('quiz before any notes explains what to do', async () => {
  const { app } = setup();
  const res = await request(app).get('/api/quiz').set(auth);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Upload some notes first/);
});

test('upload a PDF, ask a doubt with citation, list recent, get a quiz', async () => {
  const { app, db } = setup();

  const upload = await request(app).post('/api/notes/upload').set(auth)
    .attach('file', makePdf('Photosynthesis converts light energy into chemical energy in plants.'), { filename: 'Biology.pdf', contentType: 'application/pdf' });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  assert.deepEqual(upload.body, { noteId: 'note1', fileName: 'Biology.pdf', pageCount: 1 });
  assert.match(db.chunks[0].text, /Photosynthesis converts light energy/);
  assert.match(db.chunks[0].text, /chemical energy in\s+plants/); // whole sentence, not cut off
  assert.deepEqual(db.files, ['users/student1/notes/note1.pdf']);

  const ask = await request(app).post('/api/doubts/ask').set(auth).send({ question: 'What is photosynthesis?', conversationId: '' });
  assert.equal(ask.status, 200);
  assert.equal(ask.body.answer, 'Plants make food from light.');
  assert.deepEqual(ask.body.sources, [{ fileName: 'Biology.pdf', page: 1 }]); // duplicate source ids collapsed
  assert.match(ask.body.conversationId, /^[a-f0-9]{32}$/);

  const recent = await request(app).get('/api/doubts/recent?limit=5').set(auth);
  assert.equal(recent.status, 200);
  assert.equal(recent.body.items[0].question, 'What is photosynthesis?');

  const quiz = await request(app).get('/api/quiz?count=3').set(auth);
  assert.equal(quiz.status, 200);
  assert.equal(quiz.body.questions.length, 3);
});

test('rejects bad uploads with friendly messages', async () => {
  const { app } = setup();

  const notPdf = await request(app).post('/api/notes/upload').set(auth)
    .attach('file', Buffer.from('hello world'), { filename: 'notes.pdf', contentType: 'application/pdf' });
  assert.equal(notPdf.status, 400);
  assert.equal(notPdf.body.error, "That file isn't a valid PDF.");

  const tooBig = await request(app).post('/api/notes/upload').set(auth)
    .attach('file', Buffer.alloc(2 * 1024 * 1024, 1), { filename: 'big.pdf', contentType: 'application/pdf' });
  assert.equal(tooBig.status, 413);

  const noFile = await request(app).post('/api/notes/upload').set(auth);
  assert.equal(noFile.status, 400);
});

test('free mode: upload works without Cloud Storage, AI quota errors become a friendly 429', async () => {
  const { app } = setup({ files: null });
  const upload = await request(app).post('/api/notes/upload').set(auth)
    .attach('file', makePdf('Newton second law says force equals mass times acceleration.'), { filename: 'Physics.pdf', contentType: 'application/pdf' });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));

  const { app: busyApp } = setup({
    aiOverrides: { answerQuestion: async () => { const e = new Error('quota'); e.status = 429; throw e; } },
  });
  const busy = await request(busyApp).post('/api/doubts/ask').set(auth).send({ question: 'What is force?' });
  assert.equal(busy.status, 429);
  assert.match(busy.body.error, /busy/);
});

test('cosine distance ranks similar vectors first', () => {
  const { cosineDistance } = require('../src/store');
  assert.ok(Math.abs(cosineDistance([1, 0], [2, 0])) < 1e-9);
  assert.ok(Math.abs(cosineDistance([1, 0], [0, 1]) - 1) < 1e-9);
  assert.ok(cosineDistance([1, 1], [1, 0.9]) < cosineDistance([1, 1], [1, -1]));
});

test('validates the question', async () => {
  const { app } = setup();
  const empty = await request(app).post('/api/doubts/ask').set(auth).send({ question: '   ' });
  assert.equal(empty.status, 400);
  const long = await request(app).post('/api/doubts/ask').set(auth).send({ question: 'x'.repeat(1001) });
  assert.equal(long.status, 400);
});
