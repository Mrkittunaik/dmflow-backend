// routes/joiner.js
// Candidate-facing joiner endpoints: verify ID + submit form
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const Joiner   = require('../models/Joiner');
const JoiningSlot = require('../models/JoiningSlot');

// ── Multer: memory storage, 5MB per file ────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },   // 5MB max
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP, PDF files are allowed.'));
  },
});

const uploadFields = upload.fields([
  { name: 'passport',   maxCount: 1 },
  { name: 'collegeid',  maxCount: 1 },
  { name: 'aadhar',     maxCount: 1 },
  { name: 'noc',        maxCount: 1 },
]);

// ── GET /api/joiner/verify/:id ───────────────────────────────
// Candidate enters their 8-char ID → returns internship details if valid
router.get('/verify/:id', async (req, res) => {
  try {
    const joiningId = req.params.id.trim().toUpperCase();
    const slot = await JoiningSlot.findOne({ joiningId });

    if (!slot) return res.status(404).json({ valid: false, message: 'Invalid Joining ID.' });
    if (slot.used)  return res.status(410).json({ valid: false, message: 'This Joining ID has already been used.' });
    if (slot.expiresAt && slot.expiresAt < new Date())
      return res.status(410).json({ valid: false, message: 'This Joining ID has expired.' });

    res.json({
      valid:        true,
      joiningId:    slot.joiningId,
      role:         slot.role,
      stipend:      slot.stipend,
      duration:     slot.duration,
      startDate:    slot.startDate,
      mode:         slot.mode,
      offerLetter:  slot.offerLetter,
      certTemplate: slot.certTemplate,
    });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ valid: false, message: 'Server error. Please try again.' });
  }
});

// ── POST /api/joiner/submit/:id ──────────────────────────────
// Candidate submits completed joining form (multipart)
router.post('/submit/:id', uploadFields, async (req, res) => {
  try {
    const joiningId = req.params.id.trim().toUpperCase();
    const slot = await JoiningSlot.findOne({ joiningId });

    if (!slot)      return res.status(404).json({ error: 'Invalid Joining ID.' });
    if (slot.used)  return res.status(410).json({ error: 'This Joining ID has already been used.' });
    if (slot.expiresAt && slot.expiresAt < new Date())
      return res.status(410).json({ error: 'This Joining ID has expired.' });

    // Validate required fields
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    // Helper to extract uploaded file
    const fileDoc = (fieldName) => {
      const file = req.files?.[fieldName]?.[0];
      if (!file) return undefined;
      return {
        data:        file.buffer,
        contentType: file.mimetype,
        filename:    file.originalname,
        size:        file.size,
      };
    };

    // Mask account number (store last 4 only)
    const rawAccNo = (req.body.accno || '').toString().trim();
    const accnoMasked = rawAccNo.length > 4 ? '••••' + rawAccNo.slice(-4) : rawAccNo;

    const joiner = await Joiner.create({
      joiningId,
      // internship details from slot
      role:      slot.role,
      stipend:   slot.stipend,
      duration:  slot.duration,
      startDate: slot.startDate,
      mode:      slot.mode,
      // personal
      name:       (req.body.name     || '').trim(),
      dob:         req.body.dob      || '',
      phone:       req.body.phone    || '',
      email:      (req.body.email    || '').toLowerCase().trim(),
      address:     req.body.address  || '',
      devices:     req.body.devices  || '',
      // college
      college:     req.body.college    || '',
      branch:      req.body.branch     || '',
      year:        req.body.year       || '',
      enrollment:  req.body.enrollment || '',
      // bank (account number masked)
      accname:     req.body.accname  || '',
      accnoMasked,
      ifsc:       (req.body.ifsc     || '').toUpperCase(),
      bankname:    req.body.bankname || '',
      acctype:     req.body.acctype  || '',
      // docs
      passportPhoto: fileDoc('passport'),
      collegeId:     fileDoc('collegeid'),
      aadhar:        fileDoc('aadhar'),
      noc:           fileDoc('noc'),
      // signature (base64 dataURL from canvas)
      signature: req.body.signature || '',
    });

    // Mark slot as used
    slot.used = true;
    await slot.save();

    res.status(201).json({
      ok:       true,
      joinerId: joiner._id,
      message:  'Joining form submitted successfully. HR will review within 24 hours.',
    });
  } catch (err) {
    console.error('Submit error:', err);
    // Multer file-size error
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'File too large. Max 5MB per file.' });
    res.status(500).json({ error: 'Failed to submit form. Please try again.' });
  }
});

// ── GET /api/joiner/all — HR lists all joiners ───────────────
// Note: actual HR-auth protected list is at /api/hr/joiners
// This endpoint is a convenience alias kept for hr.html backward-compat
const requireHrAuth = require('../middleware/hrAuth');
router.get('/all', requireHrAuth, async (req, res) => {
  try {
    const joiners = await Joiner.find()
      .select('-passportPhoto.data -collegeId.data -aadhar.data -noc.data -signature')
      .sort({ submittedAt: -1 });
    res.json(joiners);
  } catch {
    res.status(500).json({ error: 'Failed to fetch joiners.' });
  }
});

module.exports = router;
