// All settings come from environment variables (Render / Cloud Run dashboard, or .env locally).
//
// Two ways to run:
//  - FREE (Render + Firebase Spark + Gemini API free tier): set GEMINI_API_KEY and FIREBASE_SERVICE_ACCOUNT.
//  - Google Cloud (Cloud Run + Vertex AI, needs billing): leave GEMINI_API_KEY empty; deploy.sh sets the rest.
// Keys live only on the server, never in the Unity app.
function serviceAccount() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
  try {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service-account file on one line.');
  }
}

const account = serviceAccount();

const config = {
  port: Number(process.env.PORT) || 8080,
  serviceAccount: account,
  projectId: process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || (account && account.project_id),
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  bucket: process.env.STORAGE_BUCKET || null, // optional: keep a copy of each PDF in Cloud Storage
  useVectorIndex: process.env.VECTOR_SEARCH === 'firestore', // Firestore vector index (deploy.sh creates it)
  vertexLocation: process.env.VERTEX_LOCATION || 'us-central1',
  // gemini-2.5-* is closed to new users (Oct 2026). Fallback is tried when the main model is busy/unavailable.
  chatModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  fallbackChatModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash',
  embeddingModel: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
  embeddingDims: 768,
  maxPdfBytes: 20 * 1024 * 1024,
  maxPdfPages: 300,
  maxQuestionLength: 1000,
  maxQuizQuestions: 15,
};

function assertConfig() {
  if (!config.projectId) {
    throw new Error('Missing project id. Set FIREBASE_SERVICE_ACCOUNT (free mode) or PROJECT_ID (Cloud Run).');
  }
}

module.exports = { config, assertConfig };
