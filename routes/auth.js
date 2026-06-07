// routes/auth.js
const express        = require('express');
const router         = express.Router();
const jwt            = require('jsonwebtoken');
const crypto         = require('crypto');
const passport       = require('passport');
const User           = require('../models/User');
const requireAuth    = require('../middleware/auth');

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
  return { connected: ig.connected, username: ig.username, profilePic: ig.profilePic, userId: ig.userId };
}

// POST /auth/register
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
    res.status(201).json({ token, user: { _id: user._id, name: user.name, email: user.email, plan: user.plan, avatar: user.avatar, dmsSent: user.dmsSentMonth || 0, dmsLimit: user.dmLimit || 500, instagram: safeInstagram(user.instagram) } });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user)        return res.status(401).json({ error: 'No account with that email.' });
    if (!user.password) return res.status(401).json({ error: 'This account uses Google login.' });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Wrong password.' });

    const token = makeToken(user);
    res.cookie('dmflow_token', token, cookieOptions());
    res.json({ token, user: { _id: user._id, name: user.name, email: user.email, plan: user.plan, avatar: user.avatar, dmsSent: user.dmsSentMonth || 0, dmsLimit: user.dmLimit || 500, instagram: safeInstagram(user.instagram) } });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('dmflow_token', { path: '/' });
  res.json({ message: 'Logged out.' });
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token      = crypto.randomBytes(32).toString('hex');
    const tokenHash  = crypto.createHash('sha256').update(token).digest('hex');
    user.resetToken       = tokenHash;   // store hash only — plain token goes in email link
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
        html:    `<p>Hi ${user.name},</p><p>Click the link below to reset your password (valid for 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
      });
    } else {
      console.log('🔑 Password reset URL (dev only):', resetUrl);
    }

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /auth/reset-password
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
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /auth/google
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// GET /auth/google/callback
router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: process.env.FRONTEND_URL + '/pages/auth/login.html?error=google' }),
  (req, res) => {
    const token = makeToken(req.user);
    // Use a one-time server-side code instead of JWT in URL to avoid token in browser history / logs
    const code = require('crypto').randomBytes(24).toString('hex');
    req.app.locals.oauthCodes = req.app.locals.oauthCodes || {};
    req.app.locals.oauthCodes[code] = { token, expires: Date.now() + 60_000 }; // 60s TTL
    res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/oauth-callback.html?code=${code}&provider=google`);
  }
);

// GET /auth/google/token — exchange one-time code for JWT (called by oauth-callback.html)
router.get('/google/token', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing code.' });
  const store = req.app.locals.oauthCodes || {};
  const entry = store[code];
  if (!entry || Date.now() > entry.expires) {
    delete store[code];
    return res.status(400).json({ error: 'Code expired or invalid.' });
  }
  delete store[code]; // one-time use
  res.cookie('dmflow_token', entry.token, cookieOptions());
  res.json({ token: entry.token });
});

// GET /auth/instagram/url — requireAuth so we can sign userId into state
// ⚠️  FIX: state JWT carries userId so callback can save token server-side (token never touches the browser)
router.get('/instagram/url', requireAuth, async (req, res) => {
  try {
    const clientId    = process.env.INSTAGRAM_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.INSTAGRAM_REDIRECT_URI);
    const scope       = encodeURIComponent('instagram_business_basic');
    // Short-lived signed state — identifies the user for the callback without a session cookie
    const state = jwt.sign({ id: req.user._id }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const url = `https://www.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&response_type=code&state=${encodeURIComponent(state)}`;
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /auth/instagram/callback — exchange code, save token server-side, redirect with NO token
// ⚠️  FIX: token is saved directly in DB here (triggers User pre-save encryption hook via .save())
//          frontend only receives safe metadata: username + profilePic
router.get('/instagram/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error || !code)
      return res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?error=cancelled`);

    // Verify state and identify the user
    if (!state) return res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?error=invalid_state`);
    let userId;
    try {
      const decoded = jwt.verify(decodeURIComponent(state), process.env.JWT_SECRET);
      userId = decoded.id;
    } catch {
      return res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?error=invalid_state`);
    }

    const axios = require('axios');

    // Exchange code for short-lived token
    const tokenRes = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
        client_id:     process.env.INSTAGRAM_CLIENT_ID,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
        grant_type:    'authorization_code',
        redirect_uri:  process.env.INSTAGRAM_REDIRECT_URI,
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, user_id } = tokenRes.data;

    // Exchange for long-lived token
    const longTokenRes = await axios.get(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${process.env.INSTAGRAM_CLIENT_SECRET}&access_token=${access_token}`
    );
    const long_lived_token = longTokenRes.data.access_token;

    // Get profile info including profile picture
    const profileRes = await axios.get(
      `https://graph.instagram.com/v19.0/me?fields=id,username,name,account_type,profile_picture_url&access_token=${long_lived_token}`
    );
    const { username, name, profile_picture_url } = profileRes.data;

    // Save directly to DB using .save() so the pre-save hook encrypts the token
    const user = await User.findById(userId);
    if (!user) return res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?error=user_not_found`);

    user.instagram.connected   = true;
    user.instagram.accessToken = long_lived_token;
    user.instagram.userId      = user_id;
    user.instagram.username    = username;
    user.instagram.profilePic  = profile_picture_url || '';
    await user.save(); // pre-save hook encrypts accessToken here ✅

    // Redirect with ONLY safe display data — no token ever reaches the browser
    const safeData = encodeURIComponent(JSON.stringify({
      username,
      name: name || username,
      profilePic: profile_picture_url || '',
    }));

    res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?igData=${safeData}`);
  } catch (err) {
    console.error('Instagram callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?error=failed`);
  }
});

module.exports = router;
