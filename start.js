// Starts the DoubtBuddy API.
// The server keys (Firebase service account, Gemini API key) are stored below ENCRYPTED with AES-256-GCM,
// so this file is safe in a public repo. On Render set ONE environment variable: DOUBTBUDDY_SECRET.
// To re-create the encrypted block: node scripts/lock-secrets.js (see README).
const crypto = require('crypto');

const LOCKED = {
  iv: '1evCGvlxamM3bdQH',
  tag: '2B2GRMUCUutmLhU+KdJi+A==',
  data: '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',
};

const password = (process.env.DOUBTBUDDY_SECRET || '').trim();
if (password) {
  let secrets;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(password, 'base64url'), Buffer.from(LOCKED.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(LOCKED.tag, 'base64'));
    secrets = JSON.parse(Buffer.concat([decipher.update(Buffer.from(LOCKED.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    console.error('DOUBTBUDDY_SECRET is wrong - it does not unlock the keys in start.js. Copy it again exactly.');
    process.exit(1);
  }
  // Unlocked keys win over anything typed in the dashboard.
  for (const [name, value] of Object.entries(secrets)) {
    process.env[name] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  delete process.env.DOUBTBUDDY_SECRET; // already used; src/config.js doesn't need it
}

require('./src/server');