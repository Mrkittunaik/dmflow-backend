// routes/roles.js
// Public endpoint — careers page fetches active roles from here
const express = require('express');
const router  = express.Router();
const Role    = require('../models/Role');

// GET /api/roles — public, returns only active roles
router.get('/', async (req, res) => {
  try {
    const roles = await Role.find({ active: true }).sort({ createdAt: -1 });
    res.json(roles);
  } catch {
    res.status(500).json({ error: 'Failed to fetch roles.' });
  }
});

// POST / PUT / PATCH / DELETE — delegate to /api/hr/roles (HR-protected)
// These stubs exist so hr.html can POST to /api/roles directly if using old URL
// (hr.html was updated to use /api/hr/roles but keeping fallback here)
module.exports = router;
