const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { config, assertConfig } = require('./config');
const { createApp } = require('./app');
const { createStore } = require('./store');
const { createAi } = require('./ai');

assertConfig();

// Free mode (Render): service-account JSON from FIREBASE_SERVICE_ACCOUNT.
// Cloud Run: the attached service account (no key file).
initializeApp({
  credential: config.serviceAccount ? cert(config.serviceAccount) : applicationDefault(),
  projectId: config.projectId,
  ...(config.bucket ? { storageBucket: config.bucket } : {}),
});

// Keeping a copy of the PDF is optional (Cloud Storage needs the Blaze plan); the text is always saved in Firestore.
const bucket = config.bucket ? getStorage().bucket() : null;

const app = createApp({
  config,
  verifyIdToken: (token) => getAuth().verifyIdToken(token),
  store: createStore(getFirestore(), { useVectorIndex: config.useVectorIndex }),
  ai: createAi(config),
  files: bucket
    ? { save: (filePath, buffer, contentType) => bucket.file(filePath).save(buffer, { contentType, resumable: false }) }
    : null,
});

app.listen(config.port, () => {
  const mode = config.geminiApiKey ? 'Gemini API (free tier)' : `Vertex AI (${config.vertexLocation})`;
  console.log(`DoubtBuddy API listening on port ${config.port} - project ${config.projectId}, AI: ${mode}`);
});
