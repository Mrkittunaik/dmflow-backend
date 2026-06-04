// routes/ig.js  — Instagram media proxy for post/reel picker + token refresh
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');

// GET /api/ig/media?type=all|posts|reels
router.get('/media', requireAuth, async (req, res) => {
  try {
    const User     = require('../models/User');
    const fullUser = await User.findById(req.user._id);

    if (!fullUser?.instagram?.connected || !fullUser.instagram?.accessToken)
      return res.status(403).json({ error: 'Instagram not connected.' });

    const axios    = require('axios');
    const token    = fullUser.decryptIgToken();
    const type     = req.query.type || 'all';

    // Fetch media — always use /me/media with instagram_business_basic scope
    const fields = 'id,media_type,media_url,thumbnail_url,caption,timestamp,permalink';
    const igRes  = await axios.get(
      `https://graph.instagram.com/me/media?fields=${fields}&access_token=${token}&limit=50`
    );

    let media = igRes.data?.data || [];

    const isReel = m => m.media_type === 'VIDEO' || m.media_type === 'REELS';
    if (type === 'posts') media = media.filter(m => !isReel(m));
    if (type === 'reels') media = media.filter(m => isReel(m));

    res.json({ media });
  } catch (err) {
    console.error('IG media error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not fetch Instagram media.' });
  }
});

// POST /api/ig/refresh-token — refresh long-lived token before it expires (60 day expiry)
// Call this periodically (e.g. every 30 days) to keep the token alive
router.post('/refresh-token', requireAuth, async (req, res) => {
  try {
    const User     = require('../models/User');
    const fullUser = await User.findById(req.user._id);

    if (!fullUser?.instagram?.connected || !fullUser.instagram?.accessToken)
      return res.status(403).json({ error: 'Instagram not connected.' });

    const axios = require('axios');
    const token = fullUser.decryptIgToken();

    const refreshRes = await axios.get(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`
    );

    const newToken  = refreshRes.data.access_token;
    const expiresIn = refreshRes.data.expires_in; // seconds

    // Save new token — pre-save hook will encrypt it
    fullUser.instagram.accessToken = newToken;
    fullUser.instagram.tokenExpiry = new Date(Date.now() + expiresIn * 1000);
    await fullUser.save();

    res.json({ success: true, expiresIn });
  } catch (err) {
    console.error('IG token refresh error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not refresh Instagram token.' });
  }
});

module.exports = router;
