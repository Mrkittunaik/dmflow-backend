// routes/user.js
const express   = require('express');
const router    = express.Router();
const requireAuth = require('../middleware/auth');
const User      = require('../models/User');

// GET /api/user/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await require('../models/User').findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // If Instagram is connected, always re-fetch fresh profile pic from Instagram
    // (Instagram CDN URLs expire in 24-48h, so we refresh on every /me call)
    if (user.instagram?.connected && user.instagram?.accessToken) {
      try {
        const axios = require('axios');
        const token = user.decryptIgToken();
        const igRes = await axios.get(
          `https://graph.instagram.com/v19.0/me?fields=profile_picture_url&access_token=${token}`
        );
        const freshPic = igRes.data?.profile_picture_url || '';
        if (freshPic && freshPic !== user.instagram.profilePic) {
          user.instagram.profilePic = freshPic;
          await user.save();
        }
      } catch (igErr) {
        // IG fetch failed — just continue with whatever is stored
      }
    }

    const u = user.toObject();
    const safe = {
      ...u,
      dmsSent:  u.dmsSentMonth || 0,
      dmsLimit: u.dmLimit      || 500,
      instagram: {
        connected:  u.instagram?.connected  || false,
        username:   u.instagram?.username   || '',
        profilePic: u.instagram?.profilePic || '',
        userId:     u.instagram?.userId     || '',
        pageId:     u.instagram?.pageId     || '',
      },
    };
    delete safe.password;
    delete safe['instagram.accessToken'];
    res.json(safe);
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
