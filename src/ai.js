const { GoogleGenAI, Type } = require('@google/genai');

const EMBED_CONCURRENCY = 4;
const EMBED_BATCH = 50; // Gemini API accepts many texts per request

const TUTOR_INSTRUCTIONS = [
  'You are DoubtBuddy, a friendly and patient tutor for school and college students.',
  "Answer the student's doubt clearly and step by step, in simple language.",
  'First read the numbered note excerpts carefully. If they contain the answer, base the answer on them:',
  'use the exact facts, definitions, formulas, numbers and terms written in the notes (quote short key phrases), and do not contradict them.',
  'List the numbers of the excerpts you used in sourceIds.',
  'Only if the excerpts do not contain the answer, answer from general knowledge, start with "This is not in your notes, but", and return an empty sourceIds.',
  'Keep answers under 250 words unless a longer worked solution is needed. Use plain text, no markdown tables or images.',
].join(' ');

// Wraps Gemini: the free Gemini API when GEMINI_API_KEY is set, otherwise Vertex AI
// (authenticated by the Cloud Run service account).
function createAi(config) {
  const client = config.geminiApiKey
    ? new GoogleGenAI({ apiKey: config.geminiApiKey })
    : new GoogleGenAI({ vertexai: true, project: config.projectId, location: config.vertexLocation });

  async function embed(text, taskType) {
    const response = await withRetry(() => client.models.embedContent({
      model: config.embeddingModel,
      contents: text,
      config: { taskType, outputDimensionality: config.embeddingDims },
    }));
    const values = response.embeddings && response.embeddings[0] && response.embeddings[0].values;
    if (!values || values.length !== config.embeddingDims) throw new Error('Embedding response was empty or the wrong size.');
    return values;
  }

  async function embedDocuments(texts) {
    if (config.geminiApiKey) {
      // Gemini API: one request per batch (also saves free-tier quota).
      const results = [];
      for (let start = 0; start < texts.length; start += EMBED_BATCH) {
        const batch = texts.slice(start, start + EMBED_BATCH);
        const response = await withRetry(() => client.models.embedContent({
          model: config.embeddingModel,
          contents: batch,
          config: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: config.embeddingDims },
        }));
        const vectors = (response.embeddings || []).map((e) => e.values);
        if (vectors.length !== batch.length || vectors.some((v) => !v || v.length !== config.embeddingDims)) {
          throw new Error('Embedding response was empty or the wrong size.');
        }
        results.push(...vectors);
      }
      return results;
    }

    // Vertex AI's gemini-embedding-001 takes one text per request, so run a few in parallel.
    const results = new Array(texts.length);
    let next = 0;
    async function worker() {
      while (next < texts.length) {
        const index = next++;
        results[index] = await embed(texts[index], 'RETRIEVAL_DOCUMENT');
      }
    }
    await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, texts.length) }, worker));
    return results;
  }

  function embedQuery(text) {
    return embed(text, 'RETRIEVAL_QUERY');
  }

  async function answerQuestion({ question, chunks, history }) {
    const excerpts = chunks.length
      ? chunks.map((c, i) => `[${i}] (${c.fileName}, page ${c.page})\n${c.text}`).join('\n\n')
      : '(The student has not uploaded notes that match this question.)';
    const previous = history.length
      ? history.map((h) => `Student: ${h.question}\nDoubtBuddy: ${h.answer}`).join('\n\n')
      : '(none)';

    const prompt = `Earlier in this conversation:\n${previous}\n\nNote excerpts:\n${excerpts}\n\nStudent's doubt:\n${question}`;
    const result = await generateJson(prompt, TUTOR_INSTRUCTIONS, {
      type: Type.OBJECT,
      properties: {
        answer: { type: Type.STRING },
        sourceIds: { type: Type.ARRAY, items: { type: Type.INTEGER } },
      },
      required: ['answer', 'sourceIds'],
    }, 0.2);

    return {
      answer: String(result.answer || '').trim(),
      sourceIds: Array.isArray(result.sourceIds) ? result.sourceIds.filter(Number.isInteger) : [],
    };
  }

  async function generateQuiz({ chunks, count }) {
    const notes = chunks.map((c) => `(${c.fileName}, page ${c.page})\n${c.text}`).join('\n\n');
    const prompt = `Create ${count} multiple-choice questions that test understanding of these study notes.\n\n${notes}`;
    const instructions = 'You write fair exam-style quiz questions for students. Each question has exactly 4 options, '
      + 'exactly one correct answer (correctIndex 0-3, vary its position), plausible wrong options, and a one-sentence explanation. '
      + 'Only use facts from the notes.';

    const result = await generateJson(prompt, instructions, {
      type: Type.OBJECT,
      properties: {
        questions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              options: { type: Type.ARRAY, items: { type: Type.STRING } },
              correctIndex: { type: Type.INTEGER },
              explanation: { type: Type.STRING },
            },
            required: ['question', 'options', 'correctIndex', 'explanation'],
          },
        },
      },
      required: ['questions'],
    }, 0.7);

    return (result.questions || []).filter((q) => q
      && typeof q.question === 'string' && q.question.trim()
      && Array.isArray(q.options) && q.options.length === 4 && q.options.every((o) => typeof o === 'string' && o.trim())
      && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3)
      .slice(0, count);
  }

  async function generateJson(prompt, systemInstruction, responseSchema, temperature) {
    const call = (model) => withRetry(() => client.models.generateContent({
      model,
      contents: prompt,
      config: { systemInstruction, temperature, responseMimeType: 'application/json', responseSchema },
    }));

    let response;
    try {
      response = await call(config.chatModel);
    } catch (err) {
      const status = err && err.status;
      const canFallBack = config.fallbackChatModel && config.fallbackChatModel !== config.chatModel
        && (status === 404 || status === 429 || status === 500 || status === 503);
      if (!canFallBack) throw err;
      console.warn(`[ai] ${config.chatModel} failed (${status}), trying ${config.fallbackChatModel}`);
      response = await call(config.fallbackChatModel);
    }
    try {
      return JSON.parse(response.text);
    } catch {
      throw new Error(`Gemini returned invalid JSON: ${String(response.text).slice(0, 200)}`);
    }
  }

  return { embedDocuments, embedQuery, answerQuestion, generateQuiz };
}

// Retries rate-limit (429) and temporary server errors with exponential backoff.
async function withRetry(fn, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err && (err.status || err.code);
      const retryable = status === 429 || status === 500 || status === 503 || status === 'RESOURCE_EXHAUSTED';
      if (!retryable || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt + Math.random() * 250));
    }
  }
}

module.exports = { createAi };
