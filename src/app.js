const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { createRoutes } = require('./routes');
const { HttpError } = require('./errors');

function createApp(services) {
  const app = express();
  app.set('trust proxy', 1); // Cloud Run sits behind one Google front end
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '20kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', createRoutes(services));

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // Errors: clear messages for things the student can fix, nothing internal leaks for the rest.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const mb = Math.round(services.config.maxPdfBytes / (1024 * 1024));
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `That PDF is too large (${mb} MB max).` : 'Invalid upload.';
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
    }
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    if (err && (err.status === 429 || err.code === 'RESOURCE_EXHAUSTED')) {
      console.warn('[warn] Gemini rate limit / quota reached:', err.message);
      return res.status(429).json({ error: 'DoubtBuddy is busy right now. Please try again in a minute.' });
    }

    if (err && err.code === 9 && /index/i.test(err.message || '')) {
      console.error('[error] Firestore vector index missing - run deploy.sh (it creates the index).', err.message);
    } else {
      console.error('[error]', err);
    }
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
