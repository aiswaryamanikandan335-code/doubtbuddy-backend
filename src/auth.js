// Every /api route needs "Authorization: Bearer <Firebase ID token>" (sent by the Unity app).
function requireUser(verifyIdToken) {
  return async (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({ error: 'Please sign in.' });

    try {
      const decoded = await verifyIdToken(match[1]);
      req.user = { uid: decoded.uid, email: decoded.email || null };
      return next();
    } catch {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
  };
}

module.exports = { requireUser };
