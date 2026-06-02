// routes/ig.js  — Instagram media proxy for post/reel picker
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');

// GET /api/ig/media?type=all|posts|reels
router.get('/media', requireAuth, async (req, res) => {
  try {
    // req.user has instagram.accessToken stripped by middleware — load full user here
    const User     = require('../models/User');
    const fullUser = await User.findById(req.user._id);

    if (!fullUser?.instagram?.connected || !fullUser.instagram?.accessToken)
      return res.status(403).json({ error: 'Instagram not connected.' });

    const axios    = require('axios');
    const token    = fullUser.decryptIgToken();
    const igUserId = fullUser.instagram.userId;
    const type     = req.query.type || 'all';

    // Fetch media from Instagram Graph API
    const fields = 'id,media_type,media_url,thumbnail_url,caption,timestamp,permalink';
    const igRes  = await axios.get(
      `https://graph.instagram.com/${igUserId}/media?fields=${fields}&access_token=${token}&limit=50`
    );

    let media = igRes.data?.data || [];

    if (type === 'posts') media = media.filter(m => m.media_type !== 'VIDEO');
    if (type === 'reels') media = media.filter(m => m.media_type === 'VIDEO');

    res.json({ media });
  } catch (err) {
    console.error('IG media error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not fetch Instagram media.' });
  }
});

module.exports = router;
