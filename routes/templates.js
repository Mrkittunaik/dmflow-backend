// routes/templates.js  — uses existing Template model unchanged
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const Template    = require('../models/Template');

// GET /api/templates
// Frontend expects "name" field — Template model stores it as "title"
// Map title -> name so frontend works without changing the existing model
router.get('/', requireAuth, async (req, res) => {
  try {
    const templates = await Template.find().sort({ order: 1 });
    const mapped = templates.map(t => ({
      ...t.toObject(),
      name: t.title,   // frontend uses tpl.name, model has tpl.title
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
