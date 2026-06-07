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
      return res.status(403).json({ error: 'Instagram not connected.', code: 'IG_NOT_CONNECTED' });

    const axios = require('axios');
    let token;
    try {
      token = fullUser.decryptIgToken();
    } catch(decryptErr) {
      console.error('Token decrypt failed:', decryptErr.message);
      return res.status(403).json({ error: 'Instagram token invalid. Please reconnect Instagram.', code: 'TOKEN_DECRYPT_FAILED' });
    }

    if (!token) return res.status(403).json({ error: 'Instagram token missing. Please reconnect Instagram.', code: 'TOKEN_MISSING' });

    const type   = req.query.type || 'all';
    const fields = 'id,media_type,media_url,thumbnail_url,caption,timestamp,permalink';

    const igRes = await axios.get(
      `https://graph.instagram.com/me/media?fields=${fields}&access_token=${token}&limit=50`
    );

    let media = igRes.data?.data || [];

    const isReel = m => m.media_type === 'VIDEO' || m.media_type === 'REELS';
    if (type === 'posts') media = media.filter(m => !isReel(m));
    if (type === 'reels') media = media.filter(m => isReel(m));

    res.json({ media });
  } catch (err) {
    const igErr = err.response?.data;
    console.error('IG media error:', igErr || err.message);
    // If IG returns token expired/invalid error
    if (igErr?.error?.code === 190) {
      return res.status(401).json({ error: 'Instagram token expired. Please reconnect Instagram.', code: 'TOKEN_EXPIRED' });
    }
    res.status(500).json({ error: 'Could not fetch Instagram media.', detail: igErr?.error?.message || err.message });
  }
});

// POST /api/ig/refresh-token
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
    const expiresIn = refreshRes.data.expires_in;

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
