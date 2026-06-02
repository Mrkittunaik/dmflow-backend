// routes/keywords.js  — uses new Keyword model
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const Keyword     = require('../models/Keyword');

// GET /api/keywords
router.get('/', requireAuth, async (req, res) => {
  try {
    const keywords = await Keyword.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(keywords);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/keywords
router.post('/', requireAuth, async (req, res) => {
  try {
    const { word, replyText, dmText, matchType } = req.body;
    if (!word) return res.status(400).json({ error: 'Keyword word is required.' });

    const existing = await Keyword.findOne({ userId: req.user._id, word: word.toUpperCase() });
    if (existing) return res.status(409).json({ error: 'That keyword already exists.' });

    const keyword = await Keyword.create({ userId: req.user._id, word, replyText, dmText, matchType });
    res.status(201).json(keyword);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/keywords/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const keyword = await Keyword.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true }
    );
    if (!keyword) return res.status(404).json({ error: 'Keyword not found.' });
    res.json(keyword);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/keywords/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const keyword = await Keyword.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!keyword) return res.status(404).json({ error: 'Keyword not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
