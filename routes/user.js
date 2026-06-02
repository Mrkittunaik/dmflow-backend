// routes/user.js
const express   = require('express');
const router    = express.Router();
const requireAuth = require('../middleware/auth');
const User      = require('../models/User');

// GET /api/user/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    // req.user already set by middleware (no password, no instagram.accessToken)
    res.json(req.user);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/user/profile
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { name, avatar } = req.body;
    const update = {};
    if (name)   update.name   = name;
    if (avatar) update.avatar = avatar;

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true })
      .select('-password -instagram.accessToken');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ⚠️  FIX: PATCH /api/user/instagram — only allows safe display fields (username, profilePic, pageId)
//          accessToken is intentionally excluded — backend saves it directly during OAuth callback
router.patch('/instagram', requireAuth, async (req, res) => {
  try {
    const { username, pageId, profilePic } = req.body;
    const user = await User.findByIdAndUpdate(req.user._id, {
      ...(username   && { 'instagram.username':   username }),
      ...(pageId     && { 'instagram.pageId':     pageId }),
      ...(profilePic && { 'instagram.profilePic': profilePic }),
    }, { new: true }).select('-password -instagram.accessToken');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/user/instagram  — disconnect Instagram
router.delete('/instagram', requireAuth, async (req, res) => {
  try {
    // Use .save() so the pre-save hook fires and clears properly
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    user.instagram.connected   = false;
    user.instagram.accessToken = '';
    user.instagram.userId      = '';
    user.instagram.username    = '';
    user.instagram.pageId      = '';
    user.instagram.tokenExpiry = null;
    await user.save();

    const safe = await User.findById(req.user._id).select('-password -instagram.accessToken');
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
