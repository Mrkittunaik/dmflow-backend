// routes/roles.js
// Public endpoint — returns active job listings for the careers page
const express = require('express');
const router  = express.Router();
const Role    = require('../models/Role');

// GET /api/roles — public, no auth required
router.get('/', async (req, res) => {
  try {
    const roles = await Role.find({ active: true }).sort({ createdAt: -1 });
    res.json(roles);
  } catch (err) {
    console.error('Roles fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch roles.' });
  }
});

module.exports = router;
