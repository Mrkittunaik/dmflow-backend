// routes/user.js
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const User        = require('../models/User');
const axios       = require('axios');

// ── Helper: fetch fresh profilePic from Instagram ──────────────
// Called silently; never blocks the response
async function refreshProfilePic(user) {
  try {
    if (!user.instagram?.connected || !user.instagram?.accessToken) return null;
    const token  = user.decryptIgToken();
    const igRes  = await axios.get(
      `https://graph.instagram.com/v19.0/me?fields=profile_picture_url&access_token=${token}`,
      { timeout: 4000 }
    );
    const freshPic = igRes.data?.profile_picture_url || '';
    if (freshPic && freshPic !== user.instagram.profilePic) {
      user.instagram.profilePic = freshPic;
      await user.save();
    }
    return freshPic || user.instagram.profilePic;
  } catch {
    return user.instagram?.profilePic || '';
  }
}

// ── Safe response shape — never expose accessToken ─────────────
function safeUser(u) {
  return {
    _id:      u._id,
    name:     u.name,
    email:    u.email,
    avatar:   u.avatar,
    plan:     u.plan     || 'free',
    dmsSent:  u.dmsSentMonth || 0,
    dmsLimit: u.dmLimit      || 500,
    instagram: {
      connected:  u.instagram?.connected  || false,
      username:   u.instagram?.username   || '',
      profilePic: u.instagram?.profilePic || '',
      userId:     u.instagram?.userId     || '',
      pageId:     u.instagram?.pageId     || '',
    },
    createdAt: u.createdAt,
  };
}

// GET /api/user/me
// Always refreshes profilePic from Instagram so CDN URL never goes stale
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Refresh profile pic silently — updates DB if URL changed
    await refreshProfilePic(user);

    res.json(safeUser(user));
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

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true });
    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/user/instagram — safe display fields only
router.patch('/instagram', requireAuth, async (req, res) => {
  try {
    const { username, pageId, profilePic } = req.body;
    const user = await User.findByIdAndUpdate(req.user._id, {
      ...(username   && { 'instagram.username':   username }),
      ...(pageId     && { 'instagram.pageId':     pageId }),
      ...(profilePic && { 'instagram.profilePic': profilePic }),
    }, { new: true });
    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/user/instagram — disconnect Instagram
router.delete('/instagram', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    user.instagram.connected   = false;
    user.instagram.accessToken = '';
    user.instagram.userId      = '';
    user.instagram.username    = '';
    user.instagram.pageId      = '';
    user.instagram.profilePic  = '';
    user.instagram.tokenExpiry = null;
    await user.save();

    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
