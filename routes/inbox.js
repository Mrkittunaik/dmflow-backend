// routes/inbox.js  — uses new Thread model
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const Thread      = require('../models/Thread');

const PAGE_SIZE = 20;

// GET /api/inbox?page=1&search=
router.get('/', requireAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const search = req.query.search?.trim();
    const filter = { userId: req.user._id };
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ username: re }, { name: re }, { lastMessage: re }];
    }
    const [threads, total] = await Promise.all([
      Thread.find(filter).sort({ lastAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
        .select('-messages'),  // exclude messages for list view (load on open)
      Thread.countDocuments(filter),
    ]);
    res.json({ threads, total, page, pages: Math.ceil(total / PAGE_SIZE) });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/inbox/:threadId
router.get('/:threadId', requireAuth, async (req, res) => {
  try {
    const thread = await Thread.findOne({ _id: req.params.threadId, userId: req.user._id });
    if (!thread) return res.status(404).json({ error: 'Thread not found.' });
    res.json(thread);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/inbox/:threadId/reply
router.post('/:threadId/reply', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Reply text is required.' });

    const thread = await Thread.findOne({ _id: req.params.threadId, userId: req.user._id });
    if (!thread) return res.status(404).json({ error: 'Thread not found.' });

    // Load user with accessToken for IG API call
    const User = require('../models/User');
    const fullUser = await User.findById(req.user._id);
    if (!fullUser?.instagram?.connected) {
      return res.status(403).json({ error: 'Instagram not connected.' });
    }

    // Send DM via Instagram Messenger API
    const axios = require('axios');
    const igToken    = fullUser.decryptIgToken();
    const igUserId   = fullUser.instagram.userId;

    // instagram_business_manage_messages scope uses this endpoint to send DMs
    await axios.post(
      `https://graph.instagram.com/v19.0/${igUserId}/messages`,
      {
        recipient: { id: thread.igUserId },
        message:   { text },
      },
      {
        headers: { Authorization: `Bearer ${igToken}` },
      }
    );

    const message = { from: 'user', text, sentAt: new Date() };
    thread.messages.push(message);
    thread.lastMessage = text;
    thread.lastAt      = new Date();
    await thread.save();

    res.json(thread);
  } catch (err) {
    const igErr = err.response?.data?.error?.message;
    res.status(500).json({ error: igErr || 'Internal server error.' });
  }
});

// PATCH /api/inbox/:threadId/read
router.patch('/:threadId/read', requireAuth, async (req, res) => {
  try {
    const thread = await Thread.findOneAndUpdate(
      { _id: req.params.threadId, userId: req.user._id },
      { unread: false, unreadCount: 0 },
      { new: true }
    );
    if (!thread) return res.status(404).json({ error: 'Thread not found.' });
    res.json(thread);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
