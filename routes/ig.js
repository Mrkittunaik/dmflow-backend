// routes/ig.js — Advanced Instagram profile lookup + avatar proxy + media
// Anti-blocking: rotating UAs, multiple endpoints, smart retry, caching
const express     = require('express');
const router      = express.Router();
const axios       = require('axios');
const requireAuth = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────
// CACHE — 10 min TTL, max 500 entries (LRU-lite)
// ─────────────────────────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 500;

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(key); return null; }
  // Refresh recency
  _cache.delete(key);
  _cache.set(key, e);
  return e.data;
}
function cacheSet(key, data) {
  if (_cache.size >= CACHE_MAX) {
    // Evict oldest entry
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(key, { data, exp: Date.now() + CACHE_TTL });
}

// ─────────────────────────────────────────────────────────────
// ROTATING USER-AGENTS — 10 real mobile browser strings
// ─────────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/319.0.638.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.82 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 11; OnePlus 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.101 Mobile Safari/537.36',
];

// IG app IDs used by different IG web clients
const IG_APP_IDS = [
  '936619743392459', // Instagram web
  '1217981644879628', // IG lite
  '124024574287414',  // IG android
];

let _uaIndex = 0;
let _appIdIndex = 0;

function nextUA() {
  const ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
  _uaIndex++;
  return ua;
}
function nextAppId() {
  const id = IG_APP_IDS[_appIdIndex % IG_APP_IDS.length];
  _appIdIndex++;
  return id;
}

// ─────────────────────────────────────────────────────────────
// SLEEP helper for retry delays
// ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// STRATEGY 1: Instagram internal web API (primary)
// Same endpoint used by GrabGram, Instadp, save-free, etc.
// ─────────────────────────────────────────────────────────────
async function strategyWebAPI(username, attempt = 0) {
  try {
    const ua    = nextUA();
    const appId = nextAppId();
    const res = await axios.get(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      {
        headers: {
          'User-Agent': ua,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'x-ig-app-id': appId,
          'x-requested-with': 'XMLHttpRequest',
          'x-asbd-id': '198387',
          'x-csrftoken': 'missing',
          'Referer': `https://www.instagram.com/${username}/`,
          'Origin': 'https://www.instagram.com',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'Connection': 'keep-alive',
        },
        timeout: 9000,
      }
    );

    const u = res.data?.data?.user;
    if (!u) return null;
    return buildProfile(u, username, 'web_api');

  } catch (e) {
    const status = e.response?.status;
    // 429 = rate limited — retry once after delay
    if (status === 429 && attempt === 0) {
      await sleep(1500);
      return strategyWebAPI(username, 1);
    }
    console.warn(`[IG S1] failed (${status || e.message})`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 2: Instagram GraphQL (older but still works)
// ─────────────────────────────────────────────────────────────
async function strategyGraphQL(username) {
  try {
    const res = await axios.get(
      `https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`,
      {
        headers: {
          'User-Agent': nextUA(),
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://www.instagram.com/',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'keep-alive',
        },
        timeout: 9000,
      }
    );

    const u = res.data?.graphql?.user || res.data?.data?.user;
    if (!u) return null;
    return buildProfile(u, username, 'graphql');

  } catch (e) {
    console.warn(`[IG S2] failed (${e.response?.status || e.message})`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 3: Instagram embed endpoint (very rarely blocked)
// ─────────────────────────────────────────────────────────────
async function strategyEmbed(username) {
  try {
    const res = await axios.get(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en',
          'x-ig-app-id': '936619743392459',
        },
        timeout: 9000,
      }
    );
    const u = res.data?.data?.user;
    if (!u) return null;
    return buildProfile(u, username, 'embed');
  } catch (e) {
    console.warn(`[IG S3] failed (${e.response?.status || e.message})`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// STRATEGY 4: RapidAPI (paid fallback — set RAPIDAPI_KEY env)
// ─────────────────────────────────────────────────────────────
async function strategyRapidAPI(username) {
  if (!process.env.RAPIDAPI_KEY) return null;
  try {
    const res = await axios.get(
      `https://instagram-scraper-api2.p.rapidapi.com/v1/info?username_or_id_or_url=${encodeURIComponent(username)}`,
      {
        headers: {
          'x-rapidapi-host': 'instagram-scraper-api2.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        },
        timeout: 9000,
      }
    );
    const d = res.data?.data;
    if (!d) return null;
    return buildProfile(d, username, 'rapidapi');
  } catch (e) {
    console.warn(`[IG S4] failed (${e.response?.status || e.message})`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// NORMALIZE — single profile shape from any source
// ─────────────────────────────────────────────────────────────
function buildProfile(u, username, source) {
  const isBusinessOrCreator =
    u.is_business_account || u.is_professional_account ||
    ['BUSINESS','CREATOR','MEDIA_CREATOR'].includes((u.account_type || '').toUpperCase());

  return {
    found: true,
    username: u.username || username,
    fullName: u.full_name || '',
    profilePic: u.profile_pic_url_hd || u.profile_pic_url || '',
    followers: u.edge_followed_by?.count ?? u.follower_count ?? 0,
    following: u.edge_follow?.count ?? u.following_count ?? 0,
    posts: u.edge_owner_to_timeline_media?.count ?? u.media_count ?? 0,
    biography: u.biography || '',
    isVerified: u.is_verified || false,
    isPrivate: u.is_private || false,
    isBusinessOrCreator: isBusinessOrCreator || false,
    category: u.category_name || u.category || '',
    accountType: u.account_type || (isBusinessOrCreator ? 'BUSINESS' : 'PERSONAL'),
    source,
  };
}

// ─────────────────────────────────────────────────────────────
// MASTER LOOKUP — runs all strategies in order, stops on first win
// ─────────────────────────────────────────────────────────────
async function lookupProfile(username) {
  const ckey = 'profile:' + username;
  const cached = cacheGet(ckey);
  if (cached) return cached;

  // Run strategies in parallel batches for speed
  // First try S1 and S2 simultaneously
  const [s1, s2] = await Promise.all([
    strategyWebAPI(username),
    strategyGraphQL(username),
  ]);

  const result = s1 || s2;
  if (result) { cacheSet(ckey, result); return result; }

  // S1+S2 both failed — try S3 then S4
  const s3 = await strategyEmbed(username);
  if (s3) { cacheSet(ckey, s3); return s3; }

  const s4 = await strategyRapidAPI(username);
  if (s4) { cacheSet(ckey, s4); return s4; }

  return null;
}

// ─────────────────────────────────────────────────────────────
// GET /api/ig/lookup?username=xxx
// Public — no auth required (connect page pre-login)
// ─────────────────────────────────────────────────────────────
router.get('/lookup', async (req, res) => {
  try {
    const raw = (req.query.username || '').replace(/^@+/, '').trim().toLowerCase();
    if (!raw) return res.status(400).json({ error: 'Username required.' });
    if (!/^[a-z0-9._]{1,30}$/.test(raw))
      return res.status(400).json({ error: 'Invalid username format.' });

    // If user is logged in + already connected with this username — use Graph API (fastest + most accurate)
    const authHeader = req.headers.authorization || '';
    const jwtToken = req.cookies?.dmflow_token || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);
    if (jwtToken) {
      try {
        const jwt  = require('jsonwebtoken');
        const User = require('../models/User');
        const decoded  = jwt.verify(jwtToken, process.env.JWT_SECRET);
        const fullUser = await User.findById(decoded.id);
        if (fullUser?.instagram?.connected && fullUser.instagram?.accessToken) {
          const igToken = fullUser.decryptIgToken();
          const igRes = await axios.get(
            `https://graph.instagram.com/me?fields=id,username,account_type,followers_count,media_count,profile_picture_url&access_token=${igToken}`,
            { timeout: 6000 }
          );
          const p = igRes.data;
          if (p.username?.toLowerCase() === raw) {
            const isBusinessOrCreator = ['BUSINESS','MEDIA_CREATOR','CREATOR'].includes(p.account_type?.toUpperCase());
            return res.json({
              found: true,
              username: p.username,
              fullName: fullUser.instagram.fullName || '',
              profilePic: p.profile_picture_url || fullUser.instagram.profilePic || '',
              followers: p.followers_count || 0,
              following: 0,
              posts: p.media_count || 0,
              biography: '',
              isVerified: false,
              isPrivate: false,
              isBusinessOrCreator,
              category: '',
              accountType: p.account_type,
              source: 'graph_api',
            });
          }
        }
      } catch (_) { /* fall through */ }
    }

    // Run multi-strategy scraper
    const profile = await lookupProfile(raw);

    if (profile) return res.json(profile);

    // All strategies failed — return empty fallback (user can still proceed to OAuth)
    return res.json({
      found: false,
      username: raw,
      profilePic: '',
      followers: 0,
      following: 0,
      posts: 0,
      isBusinessOrCreator: null,
      fullName: '',
      isVerified: false,
      biography: '',
      category: '',
      isPrivate: false,
    });

  } catch (err) {
    console.error('[IG lookup] error:', err.message);
    res.status(500).json({ error: 'Profile lookup failed.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/ig/avatar/:username
// Proxies IG CDN profile picture — bypasses browser CORS block
// Cached: browser caches 1hr, server reuses profile cache
// ─────────────────────────────────────────────────────────────
router.get('/avatar/:username', async (req, res) => {
  try {
    const username = req.params.username.replace(/^@+/, '').trim().toLowerCase();
    if (!username || !/^[a-z0-9._]{1,30}$/.test(username))
      return res.status(400).send('Invalid username');

    // Get pic URL from cache or do a fresh lookup
    let picUrl = cacheGet('profile:' + username)?.profilePic || null;
    if (!picUrl) {
      const profile = await lookupProfile(username);
      picUrl = profile?.profilePic || null;
    }

    if (!picUrl) return res.status(404).send('Avatar not found');

    // Stream image through server
    const imgRes = await axios.get(picUrl, {
      responseType: 'stream',
      headers: {
        'User-Agent': nextUA(),
        'Referer': 'https://www.instagram.com/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: 10000,
    });

    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    imgRes.data.pipe(res);

  } catch (err) {
    console.error('[IG avatar] error:', err.message);
    res.status(502).send('Could not fetch avatar');
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/ig/media?type=all|posts|reels
// ─────────────────────────────────────────────────────────────
router.get('/media', requireAuth, async (req, res) => {
  try {
    const User     = require('../models/User');
    const fullUser = await User.findById(req.user._id);

    if (!fullUser?.instagram?.connected || !fullUser.instagram?.accessToken)
      return res.status(403).json({ error: 'Instagram not connected.', code: 'IG_NOT_CONNECTED' });

    let token;
    try { token = fullUser.decryptIgToken(); }
    catch(e) { return res.status(403).json({ error: 'Instagram token invalid. Please reconnect.', code: 'TOKEN_DECRYPT_FAILED' }); }
    if (!token) return res.status(403).json({ error: 'Instagram token missing.', code: 'TOKEN_MISSING' });

    const type   = req.query.type || 'all';
    const fields = 'id,media_type,media_url,thumbnail_url,caption,timestamp,permalink';

    const igRes = await axios.get(
      `https://graph.instagram.com/me/media?fields=${fields}&access_token=${token}&limit=50`,
      { timeout: 10000 }
    );

    let media = igRes.data?.data || [];
    const isReel = m => m.media_type === 'VIDEO' || m.media_type === 'REELS';
    if (type === 'posts') media = media.filter(m => !isReel(m));
    if (type === 'reels') media = media.filter(m => isReel(m));

    res.json({ media });

  } catch (err) {
    const igErr = err.response?.data;
    console.error('[IG media] error:', igErr || err.message);
    if (igErr?.error?.code === 190)
      return res.status(401).json({ error: 'Instagram token expired. Please reconnect.', code: 'TOKEN_EXPIRED' });
    res.status(500).json({ error: 'Could not fetch Instagram media.', detail: igErr?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ig/refresh-token
// ─────────────────────────────────────────────────────────────
router.post('/refresh-token', requireAuth, async (req, res) => {
  try {
    const User     = require('../models/User');
    const fullUser = await User.findById(req.user._id);

    if (!fullUser?.instagram?.connected || !fullUser.instagram?.accessToken)
      return res.status(403).json({ error: 'Instagram not connected.' });

    const token = fullUser.decryptIgToken();
    const refreshRes = await axios.get(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`,
      { timeout: 8000 }
    );

    fullUser.instagram.accessToken = refreshRes.data.access_token;
    fullUser.instagram.tokenExpiry = new Date(Date.now() + refreshRes.data.expires_in * 1000);
    await fullUser.save();

    res.json({ success: true, expiresIn: refreshRes.data.expires_in });

  } catch (err) {
    console.error('[IG refresh] error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not refresh Instagram token.' });
  }
});

module.exports = router;
