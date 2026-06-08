// routes/ig.js  — Instagram media proxy for post/reel picker + token refresh
const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/auth');

// GET /api/ig/lookup?username=xxx
// Live Instagram profile lookup — uses a connected user's token to validate username exists
// Returns: { username, profilePic, isBusinessOrCreator, followers }
// Falls back gracefully if token not available
router.get('/lookup', requireAuth, async (req, res) => {
  try {
    const { username } = req.query;
    if (!username || username.length < 1)
      return res.status(400).json({ error: 'Username is required.' });

    // Sanitize username
    const cleanUsername = username.replace(/^@+/, '').trim().toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(cleanUsername))
      return res.status(400).json({ error: 'Invalid username format.' });

    const axios  = require('axios');
    const User   = require('../models/User');

    // Try to use this user's own IG token to search (if already connected)
    const fullUser = await User.findById(req.user._id);

    // Option 1: User has a connected IG token — use Graph API to look up by username
    if (fullUser?.instagram?.connected && fullUser.instagram?.accessToken) {
      try {
        const token = fullUser.decryptIgToken();
        // Use IG Basic Display API — can only get info about the authenticated user
        // So we check if the username matches their own connected account
        const profileRes = await axios.get(
          `https://graph.instagram.com/me?fields=id,username,account_type,followers_count,profile_picture_url&access_token=${token}`
        );
        const p = profileRes.data;
        const isMatch = p.username?.toLowerCase() === cleanUsername;
        const isBusinessOrCreator = ['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(p.account_type?.toUpperCase());

        if (isMatch) {
          return res.json({
            found: true,
            username: p.username,
            profilePic: p.profile_picture_url || '',
            followers: p.followers_count || 0,
            accountType: p.account_type || 'PERSONAL',
            isBusinessOrCreator,
          });
        }
      } catch (tokenErr) {
        // Token call failed — fall through to scraper
        console.warn('IG token lookup failed:', tokenErr.message);
      }
    }

    // Option 2: Use RapidAPI Instagram scraper (set RAPIDAPI_KEY in .env)
    // Supports any public profile lookup
    if (process.env.RAPIDAPI_KEY) {
      try {
        const scraperRes = await axios.get(
          `https://instagram-scraper-api2.p.rapidapi.com/v1/info?username_or_id_or_url=${cleanUsername}`,
          {
            headers: {
              'x-rapidapi-host': 'instagram-scraper-api2.p.rapidapi.com',
              'x-rapidapi-key': process.env.RAPIDAPI_KEY,
            },
            timeout: 8000,
          }
        );
        const d = scraperRes.data?.data;
        if (d) {
          const accountCat = (d.account_type || d.category || '').toLowerCase();
          const isBusinessOrCreator = d.is_business_account || d.is_professional_account ||
            accountCat.includes('business') || accountCat.includes('creator') || accountCat.includes('media');
          return res.json({
            found: true,
            username: d.username || cleanUsername,
            profilePic: d.profile_pic_url_hd || d.profile_pic_url || '',
            followers: d.follower_count || d.edge_followed_by?.count || 0,
            accountType: d.account_type || (isBusinessOrCreator ? 'BUSINESS' : 'PERSONAL'),
            isBusinessOrCreator,
            fullName: d.full_name || '',
            isVerified: d.is_verified || false,
            biography: d.biography || '',
          });
        }
      } catch (scraperErr) {
        console.warn('Scraper lookup failed:', scraperErr.message);
      }
    }

    // Option 3: Fallback — return username only, no live data
    // Frontend will show placeholder card — user can still proceed to OAuth
    return res.json({
      found: false,
      username: cleanUsername,
      profilePic: '',
      followers: 0,
      accountType: 'UNKNOWN',
      isBusinessOrCreator: null, // null = unknown, not false
    });

  } catch (err) {
    console.error('IG lookup error:', err.message);
    res.status(500).json({ error: 'Profile lookup failed.' });
  }
});

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
