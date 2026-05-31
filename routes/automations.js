// routes/automations.js  — uses existing Automation model unchanged
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const Automation  = require('../models/Automation');

// GET /api/automations
router.get('/', requireAuth, async (req, res) => {
  try {
    const automations = await Automation.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(automations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/automations
router.post('/', requireAuth, async (req, res) => {
  try {
    const automation = await Automation.create({ ...req.body, userId: req.user._id });
    res.status(201).json(automation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/automations/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const automation = await Automation.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true }
    );
    if (!automation) return res.status(404).json({ error: 'Automation not found.' });
    res.json(automation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/automations/:id/toggle
router.patch('/:id/toggle', requireAuth, async (req, res) => {
  try {
    const automation = await Automation.findOne({ _id: req.params.id, userId: req.user._id });
    if (!automation) return res.status(404).json({ error: 'Automation not found.' });
    automation.active = !automation.active;
    await automation.save();
    res.json(automation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/automations/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const automation = await Automation.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!automation) return res.status(404).json({ error: 'Automation not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
