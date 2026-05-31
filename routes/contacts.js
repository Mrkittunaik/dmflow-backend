// routes/contacts.js  — uses new Contact model
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const Contact     = require('../models/Contact');

const PAGE_SIZE = 20;

// GET /api/contacts?page=1&search=
router.get('/', requireAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const search = req.query.search?.trim();
    const filter = { userId: req.user._id };
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ username: re }, { name: re }, { email: re }];
    }
    const [contacts, total] = await Promise.all([
      Contact.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE),
      Contact.countDocuments(filter),
    ]);
    res.json({ contacts, total, page, pages: Math.ceil(total / PAGE_SIZE) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/export  (must be before /:id)
router.get('/export', requireAuth, async (req, res) => {
  try {
    const contacts = await Contact.find({ userId: req.user._id }).sort({ createdAt: -1 });
    const header   = 'username,name,email,dmCount,source,createdAt';
    const rows     = contacts.map(c =>
      [c.username, c.name, c.email, c.dmCount, c.source, c.createdAt?.toISOString()].join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send([header, ...rows].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, userId: req.user._id });
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true }
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const contact = await Contact.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
