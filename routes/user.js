// routes/user.js
const express   = require('express');
const router    = express.Router();
const requireAuth = require('../middleware/auth');
const User      = require('../models/User');

// GET /api/user/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    // req.user already set by middleware (no password)
    res.json(req.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/user/profile
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { name, avatar } = req.body;
    const update = {};
    if (name)   update.name   = name;
    if (avatar) update.avatar = avatar;

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true }).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/user/instagram  — save Instagram connection data from callback
router.patch('/instagram', requireAuth, async (req, res) => {
  try {
    const { accessToken, userId, username, pageId, tokenExpiry, profilePic } = req.body;
    const user = await User.findByIdAndUpdate(req.user._id, {
      'instagram.connected':   true,
      'instagram.accessToken': accessToken,
      'instagram.userId':      userId,
      'instagram.username':    username,
      'instagram.pageId':      pageId || '',
      'instagram.tokenExpiry': tokenExpiry || null,
      'instagram.profilePic':  profilePic  || '',
    }, { new: true }).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/user/instagram  — disconnect Instagram
router.delete('/instagram', requireAuth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.user._id, {
      'instagram.connected':   false,
      'instagram.accessToken': '',
      'instagram.userId':      '',
      'instagram.username':    '',
      'instagram.pageId':      '',
      'instagram.tokenExpiry': null,
    }, { new: true }).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
