// routes/auth.js
const express        = require('express');
const router         = express.Router();
const jwt            = require('jsonwebtoken');
const crypto         = require('crypto');
const passport       = require('passport');
const axios          = require('axios');
const User           = require('../models/User');
const requireAuth    = require('../middleware/auth');

// ── Required Instagram scopes for full automation functionality ──────────────
// instagram_business_basic           → profile + media access
// instagram_business_manage_messages → send/receive DMs (required for Auto DM)
// instagram_business_manage_comments → post comment replies (required for Comment Reply)
// instagram_business_content_publish → (optional) post content programmatically
const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
].join(',');

const IG_API_VERSION = 'v21.0';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

function makeToken(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// Safe instagram shape — never expose accessToken to frontend
function safeInstagram(ig) {
  if (!ig) return {};
  return {
    connected:  ig.connected,
    username:   ig.username,
    fullName:   ig.fullName || '',
    profilePic: ig.profilePic,
    userId:     ig.userId,
    webhookSubscribed: ig.webhookSubscribed || false,
    scopesGranted:     ig.scopesGranted || [],
  };
}

// ── Subscribe this IG account to the webhook fields we need ─────────────────
// MUST be called after every connect / reconnect.
// Uses the long-lived token (plain, before encryption).
async function subscribeWebhookFields(igUserId, longLivedToken) {
  try {
    const res = await axios.post(
      `https://graph.instagram.com/${IG_API_VERSION}/${igUserId}/subscribed_apps`,
      null,
      {
        params: {
          subscribed_fields: 'comments,messages,mentions,story_insights',
          access_token: longLivedToken,
        },
        timeout: 10000,
      }
    );
    const success = res.data?.success === true;
    console.log(`✅ Webhook fields subscribed for IG user ${igUserId}:`, res.data);
    return success;
  } catch (e) {
    // Log full error so we can diagnose permission issues
    console.error(
      `⚠️  subscribed_apps failed for IG user ${igUserId}:`,
      e.response?.data || e.message
    );
    return false;
  }
}

// ── Verify current webhook subscription status ───────────────────────────────
async function getWebhookSubscription(igUserId, longLivedToken) {
  try {
    const res = await axios.get(
      `https://graph.instagram.com/${IG_API_VERSION}/${igUserId}/subscribed_apps`,
      { params: { access_token: longLivedToken }, timeout: 8000 }
    );
    return res.data;
  } catch (e) {
    console.error('getWebhookSubscription error:', e.response?.data || e.message);
    return null;
  }
}

// ── POST /auth/register ──────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required.' });

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email))
      return res.status(400).json({ error: 'Please enter a valid email address.' });

    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    if (name.length > 100 || email.length > 200 || password.length > 200)
      return res.status(400).json({ error: 'Input too long.' });

    if (await User.findOne({ email: email.toLowerCase() }))
      return res.status(409).json({ error: 'An account with that email already exists.' });

    const user  = await User.create({ name, email, password });
    const token = makeToken(user);
    res.cookie('dmflow_token', token, cookieOptions());
    res.status(201).json({
      token,
      user: {
        _id: user._id, name: user.name, email: user.email,
        plan: user.plan, avatar: user.avatar,
        dmsSent: user.dmsSentMonth || 0, dmsLimit: user.dmLimit || 500,
        instagram: safeInstagram(user.instagram),
      },
    });
  } catch (err) {
    console.error('register error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user)          return res.status(401).json({ error: 'No account with that email.' });
    if (!user.password) return res.status(401).json({ error: 'This account uses Google login.' });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Wrong password.' });

    const token = makeToken(user);
    res.cookie('dmflow_token', token, cookieOptions());
    res.json({
      token,
      user: {
        _id: user._id, name: user.name, email: user.email,
        plan: user.plan, avatar: user.avatar,
        dmsSent: user.dmsSentMonth || 0, dmsLimit: user.dmLimit || 500,
        instagram: safeInstagram(user.instagram),
      },
    });
  } catch (err) {
    console.error('login error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /auth/logout ────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('dmflow_token', { path: '/' });
  res.json({ message: 'Logged out.' });
});

// ── POST /auth/forgot-password ───────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token      = crypto.randomBytes(32).toString('hex');
    const tokenHash  = crypto.createHash('sha256').update(token).digest('hex');
    user.resetToken       = tokenHash;
    user.resetTokenExpiry = Date.now() + 1000 * 60 * 60;
    await user.save();

    const resetUrl = `${process.env.FRONTEND_URL}/pages/auth/forgot-password.html?token=${token}`;

    if (process.env.SMTP_HOST) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || 'noreply@dmflow.in',
        to:      user.email,
        subject: 'Reset your DMFlow password',
        html: `<p>Hi ${user.name},</p><p>Click the link below to reset your password (valid for 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
      });
    } else {
      console.log('🔑 Password reset URL (dev only):', resetUrl);
    }

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('forgot-password error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /auth/reset-password ────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ error: 'Token and new password are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({ resetToken: tokenHash, resetTokenExpiry: { $gt: Date.now() } });
    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired.' });

    user.password         = password;
    user.resetToken       = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    console.error('reset-password error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /auth/google ─────────────────────────────────────────────────────────
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// ── GET /auth/google/callback ────────────────────────────────────────────────
router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: process.env.FRONTEND_URL + '/pages/auth/login.html?error=google' }),
  (req, res) => {
    const token = makeToken(req.user);
    const code = crypto.randomBytes(24).toString('hex');
    req.app.locals.oauthCodes = req.app.locals.oauthCodes || {};
    req.app.locals.oauthCodes[code] = { token, expires: Date.now() + 60_000 };
    res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/oauth-callback.html?code=${code}&provider=google`);
  }
);

// ── GET /auth/google/token ───────────────────────────────────────────────────
router.get('/google/token', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing code.' });
  const store = req.app.locals.oauthCodes || {};
  const entry = store[code];
  if (!entry || Date.now() > entry.expires) {
    delete store[code];
    return res.status(400).json({ error: 'Code expired or invalid.' });
  }
  delete store[code];
  res.cookie('dmflow_token', entry.token, cookieOptions());
  res.json({ token: entry.token });
});

// ── GET /auth/instagram/url ──────────────────────────────────────────────────
// Returns the Instagram OAuth URL with ALL required scopes.
router.get('/instagram/url', requireAuth, async (req, res) => {
  try {
    const clientId    = process.env.INSTAGRAM_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.INSTAGRAM_REDIRECT_URI);
    const scope       = encodeURIComponent(IG_SCOPES);
    const state       = jwt.sign({ id: req.user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const url = `https://www.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&response_type=code&state=${encodeURIComponent(state)}`;
    res.json({ url });
  } catch (err) {
    console.error('instagram/url error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /auth/instagram/callback ─────────────────────────────────────────────
// Exchanges the code, saves token encrypted in DB, subscribes webhook fields.
// The browser NEVER sees the access token — only safe profile metadata is returned.
router.get('/instagram/callback', async (req, res) => {
  const REDIRECT_BASE = `${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html`;

  try {
    const { code, error, state } = req.query;

    if (error || !code)
      return res.redirect(`${REDIRECT_BASE}?error=cancelled`);

    if (!state)
      return res.redirect(`${REDIRECT_BASE}?error=invalid_state`);

    // Verify state JWT and extract userId
    let userId;
    try {
      const decoded = jwt.verify(decodeURIComponent(state), process.env.JWT_SECRET);
      userId = decoded.id;
    } catch {
      return res.redirect(`${REDIRECT_BASE}?error=invalid_state`);
    }

    // ── Step 1: Exchange code for short-lived token ───────────────────────
    let shortToken, igUserId;
    try {
      const tokenRes = await axios.post(
        'https://api.instagram.com/oauth/access_token',
        new URLSearchParams({
          client_id:     process.env.INSTAGRAM_CLIENT_ID,
          client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
          grant_type:    'authorization_code',
          redirect_uri:  process.env.INSTAGRAM_REDIRECT_URI,
          code,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      shortToken = tokenRes.data.access_token;
      igUserId   = String(tokenRes.data.user_id);
    } catch (e) {
      console.error('IG short token exchange failed:', e.response?.data || e.message);
      return res.redirect(`${REDIRECT_BASE}?error=token_exchange_failed`);
    }

    // ── Step 2: Exchange short-lived token for long-lived token ──────────
    let longLivedToken, tokenExpiresIn;
    try {
      const longTokenRes = await axios.get(
        `https://graph.instagram.com/access_token`,
        {
          params: {
            grant_type:    'ig_exchange_token',
            client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
            access_token:  shortToken,
          },
          timeout: 10000,
        }
      );
      longLivedToken  = longTokenRes.data.access_token;
      tokenExpiresIn  = longTokenRes.data.expires_in; // seconds, ~60 days
    } catch (e) {
      console.error('IG long token exchange failed:', e.response?.data || e.message);
      return res.redirect(`${REDIRECT_BASE}?error=token_exchange_failed`);
    }

    // ── Step 3: Fetch profile info ────────────────────────────────────────
    let username, name, profile_picture_url, account_type;
    try {
      const profileRes = await axios.get(
        `https://graph.instagram.com/${IG_API_VERSION}/me`,
        {
          params: {
            fields:       'id,username,name,account_type,profile_picture_url',
            access_token: longLivedToken,
          },
          timeout: 8000,
        }
      );
     ({ id: igUserId, username, name, profile_picture_url, account_type } = profileRes.data);
    } catch (e) {
      console.error('IG profile fetch failed:', e.response?.data || e.message);
      return res.redirect(`${REDIRECT_BASE}?error=profile_fetch_failed`);
    }

    // ── Step 4: Save to DB (pre-save hook encrypts the token) ────────────
    const user = await User.findById(userId);
    if (!user) return res.redirect(`${REDIRECT_BASE}?error=user_not_found`);

    user.instagram.connected     = true;
    user.instagram.accessToken   = longLivedToken;  // encrypted by pre-save hook
    user.instagram.userId        = igUserId;
    user.instagram.username      = username;
    user.instagram.fullName      = name || username;
    user.instagram.profilePic    = profile_picture_url || '';
    user.instagram.accountType   = account_type || '';
    user.instagram.tokenExpiry   = new Date(Date.now() + tokenExpiresIn * 1000);
    // Mark as NOT yet subscribed — we'll update this right after
    user.instagram.webhookSubscribed = false;
    user.instagram.scopesGranted     = IG_SCOPES.split(',');

    await user.save(); // pre-save hook encrypts accessToken ✅

    // ── Step 5: Subscribe to Instagram webhook fields ────────────────────
    // CRITICAL: Without this, Instagram will NEVER send comment or message
    // events to our webhook endpoint. Must be done with the PLAIN (unencrypted)
    // long-lived token immediately after connecting.
    const subscribed = await subscribeWebhookFields(igUserId, longLivedToken);

    if (subscribed) {
      // Update flag atomically — don't re-save the whole user doc
      // (avoids re-triggering the token encryption hook)
      await User.findByIdAndUpdate(userId, {
        'instagram.webhookSubscribed': true,
      });
      console.log(`✅ IG account ${username} (${igUserId}) fully connected + webhook subscribed`);
    } else {
      console.warn(`⚠️  IG account ${username} connected but webhook subscription FAILED — automations won't trigger until re-connected or subscription is manually fixed`);
    }

    // ── Step 6: Return ONLY safe display data to the browser ─────────────
    const safeData = encodeURIComponent(JSON.stringify({
      username,
      name:       name || username,
      profilePic: profile_picture_url || '',
      webhookSubscribed: subscribed,
    }));

    res.redirect(`${REDIRECT_BASE}?igData=${safeData}`);
  } catch (err) {
    console.error('Instagram callback error:', err.response?.data || err.message);
    res.redirect(`${REDIRECT_BASE}?error=failed`);
  }
});

// ── GET /auth/instagram/disconnect ───────────────────────────────────────────
// Clears the stored IG token and marks account as disconnected.
router.post('/instagram/disconnect', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    user.instagram.connected         = false;
    user.instagram.accessToken       = '';
    user.instagram.userId            = '';
    user.instagram.webhookSubscribed = false;
    user.instagram.scopesGranted     = [];
    await user.save();

    res.json({ message: 'Instagram disconnected.' });
  } catch (err) {
    console.error('instagram/disconnect error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /auth/instagram/subscription-status ──────────────────────────────────
// Returns live subscription info from Meta — useful for debugging.
router.get('/instagram/subscription-status', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user?.instagram?.connected || !user.instagram?.accessToken)
      return res.status(403).json({ error: 'Instagram not connected.' });

    const token = user.decryptIgToken();
    const data  = await getWebhookSubscription(user.instagram.userId, token);

    res.json({
      dbFlag:     user.instagram.webhookSubscribed || false,
      metaData:   data,
      scopes:     user.instagram.scopesGranted || [],
      tokenExpiry: user.instagram.tokenExpiry || null,
    });
  } catch (err) {
    console.error('subscription-status error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /auth/instagram/resubscribe ─────────────────────────────────────────
// Manually re-triggers the subscribed_apps call. Useful if webhook was lost.
router.post('/instagram/resubscribe', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user?.instagram?.connected || !user.instagram?.accessToken)
      return res.status(403).json({ error: 'Instagram not connected.' });

    const token     = user.decryptIgToken();
    const subscribed = await subscribeWebhookFields(user.instagram.userId, token);

    await User.findByIdAndUpdate(req.user._id, {
      'instagram.webhookSubscribed': subscribed,
    });

    res.json({
      success: subscribed,
      message: subscribed
        ? 'Webhook fields re-subscribed successfully.'
        : 'Subscription failed. Check server logs for details.',
    });
  } catch (err) {
    console.error('resubscribe error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
