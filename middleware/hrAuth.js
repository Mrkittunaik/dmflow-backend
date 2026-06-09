// middleware/hrAuth.js
const jwt = require('jsonwebtoken');

module.exports = function requireHrAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'HR auth required.' });

  try {
    const decoded = jwt.verify(token, process.env.HR_JWT_SECRET || process.env.JWT_SECRET);
    if (decoded.role !== 'hr') return res.status(403).json({ error: 'Forbidden.' });
    req.hr = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired HR token.' });
  }
};
