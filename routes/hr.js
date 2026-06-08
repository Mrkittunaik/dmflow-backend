// routes/hr.js
// HR-only endpoints: login, role management, joiner review, ID generation
const express      = require('express');
const router       = express.Router();
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const requireHrAuth = require('../middleware/hrAuth');
const Role         = require('../models/Role');
const Joiner       = require('../models/Joiner');
const JoiningSlot  = require('../models/JoiningSlot');

// ── Helpers ───────────────────────────────────────────────────
function makeHrToken() {
  return jwt.sign(
    { role: 'hr', iat: Date.now() },
    process.env.HR_JWT_SECRET || process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function generateId() {
  // 8-char alphanumeric, starts with DMFL
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return 'DMFL' + suffix;
}

// ── POST /api/hr/login ─────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required.' });

    const expectedUser = process.env.HR_USERNAME || 'admin';
    const expectedHash = process.env.HR_PASSWORD_HASH;

    if (!expectedHash) {
      return res.status(503).json({ error: 'HR credentials not configured on server.' });
    }

    if (username !== expectedUser) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const match = await bcrypt.compare(password, expectedHash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = makeHrToken();
    return res.json({ token, username: expectedUser });
  } catch (err) {
    console.error('HR login error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /api/hr/me — verify token is still valid ──────────────
router.get('/me', requireHrAuth, (req, res) => {
  res.json({ ok: true, role: 'hr' });
});

// ═══════════════════════════════════════════════════════════════
// ROLE MANAGEMENT (HR-protected write ops)
// ═══════════════════════════════════════════════════════════════

// GET /api/hr/roles (HR view — includes inactive)
router.get('/roles', requireHrAuth, async (req, res) => {
  try {
    const roles = await Role.find().sort({ createdAt: -1 });
    res.json(roles);
  } catch {
    res.status(500).json({ error: 'Failed to fetch roles.' });
  }
});

// POST /api/hr/roles
router.post('/roles', requireHrAuth, async (req, res) => {
  try {
    const { title, stipend, duration, skills, mode, active, formLink } = req.body;
    if (!title) return res.status(400).json({ error: 'Job title is required.' });
    const role = await Role.create({ title, stipend, duration, skills, mode, active, formLink });
    res.status(201).json(role);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create role.' });
  }
});

// PUT /api/hr/roles/:id
router.put('/roles/:id', requireHrAuth, async (req, res) => {
  try {
    const { title, stipend, duration, skills, mode, active, formLink } = req.body;
    const role = await Role.findByIdAndUpdate(
      req.params.id,
      { title, stipend, duration, skills, mode, active, formLink },
      { new: true, runValidators: true }
    );
    if (!role) return res.status(404).json({ error: 'Role not found.' });
    res.json(role);
  } catch {
    res.status(500).json({ error: 'Failed to update role.' });
  }
});

// PATCH /api/hr/roles/:id  (toggle active)
router.patch('/roles/:id', requireHrAuth, async (req, res) => {
  try {
    const role = await Role.findByIdAndUpdate(
      req.params.id,
      { active: req.body.active },
      { new: true }
    );
    if (!role) return res.status(404).json({ error: 'Role not found.' });
    res.json(role);
  } catch {
    res.status(500).json({ error: 'Failed to update role.' });
  }
});

// DELETE /api/hr/roles/:id
router.delete('/roles/:id', requireHrAuth, async (req, res) => {
  try {
    await Role.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete role.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// JOINING ID GENERATION
// ═══════════════════════════════════════════════════════════════

// POST /api/hr/generate-id
router.post('/generate-id', requireHrAuth, async (req, res) => {
  try {
    const { roleId, role, stipend, duration, startDate, mode, offerLetter, certTemplate } = req.body;
    if (!role) return res.status(400).json({ error: 'Role name is required.' });

    // Generate unique ID (retry if collision)
    let joiningId, attempts = 0;
    do {
      joiningId = generateId();
      attempts++;
    } while (attempts < 10 && await JoiningSlot.exists({ joiningId }));

    const slot = await JoiningSlot.create({
      joiningId,
      roleId: roleId || undefined,
      role,
      stipend:      stipend     || '',
      duration:     duration    || '',
      startDate:    startDate   || '',
      mode:         mode        || 'Remote',
      offerLetter:  offerLetter  || '',
      certTemplate: certTemplate || '',
      expiresAt:    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),  // 30 days
    });

    res.status(201).json({ joiningId: slot.joiningId, slot });
  } catch (err) {
    console.error('Generate ID error:', err);
    res.status(500).json({ error: 'Failed to generate joining ID.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// JOINER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// GET /api/hr/joiners — list all submitted joiners
router.get('/joiners', requireHrAuth, async (req, res) => {
  try {
    const joiners = await Joiner.find()
      .select('-passportPhoto.data -collegeId.data -aadhar.data -noc.data -signature')
      .sort({ submittedAt: -1 });
    res.json(joiners);
  } catch {
    res.status(500).json({ error: 'Failed to fetch joiners.' });
  }
});

// GET /api/hr/joiners/:id — full joiner details (no file buffers except via separate endpoint)
router.get('/joiners/:id', requireHrAuth, async (req, res) => {
  try {
    const joiner = await Joiner.findById(req.params.id)
      .select('-passportPhoto.data -collegeId.data -aadhar.data -noc.data');
    if (!joiner) return res.status(404).json({ error: 'Joiner not found.' });
    res.json(joiner);
  } catch {
    res.status(500).json({ error: 'Failed to fetch joiner.' });
  }
});

// GET /api/hr/joiners/:id/file/:field — stream uploaded file to HR
router.get('/joiners/:id/file/:field', requireHrAuth, async (req, res) => {
  const allowed = ['passportPhoto', 'collegeId', 'aadhar', 'noc'];
  const field = req.params.field;
  if (!allowed.includes(field)) return res.status(400).json({ error: 'Invalid field.' });

  try {
    const joiner = await Joiner.findById(req.params.id).select(field);
    if (!joiner || !joiner[field]?.data)
      return res.status(404).json({ error: 'File not found.' });

    res.set('Content-Type',        joiner[field].contentType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${joiner[field].filename || field}"`);
    res.send(joiner[field].data);
  } catch {
    res.status(500).json({ error: 'Failed to serve file.' });
  }
});

// GET /api/hr/joiners/:id/signature — get signature image
router.get('/joiners/:id/signature', requireHrAuth, async (req, res) => {
  try {
    const joiner = await Joiner.findById(req.params.id).select('signature');
    if (!joiner?.signature) return res.status(404).json({ error: 'Signature not found.' });
    // signature is a dataURL — send as JSON so frontend can display <img src=...>
    res.json({ signature: joiner.signature });
  } catch {
    res.status(500).json({ error: 'Failed to fetch signature.' });
  }
});

// PATCH /api/hr/joiners/:id/status — approve / reject
router.patch('/joiners/:id/status', requireHrAuth, async (req, res) => {
  try {
    const { status, hrNote } = req.body;
    if (!['pending', 'approved', 'rejected'].includes(status))
      return res.status(400).json({ error: 'Invalid status.' });

    const joiner = await Joiner.findByIdAndUpdate(
      req.params.id,
      { status, ...(hrNote !== undefined && { hrNote }) },
      { new: true }
    ).select('-passportPhoto.data -collegeId.data -aadhar.data -noc.data -signature');

    if (!joiner) return res.status(404).json({ error: 'Joiner not found.' });
    res.json(joiner);
  } catch {
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

module.exports = router;
