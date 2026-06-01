// routes/auth.js
const express        = require('express');
const router         = express.Router();
const jwt            = require('jsonwebtoken');
const crypto         = require('crypto');
const passport       = require('passport');
const User           = require('../models/User');

function makeToken(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
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

    if (name.length > 100 || email.length > 200 || password.length > 200)
      return res.status(400).json({ error: 'Input too long.' });

    if (await User.findOne({ email: email.toLowerCase() }))
      return res.status(409).json({ error: 'An account with that email already exists.' });

    const user  = await User.create({ name, email, password });
    const token = makeToken(user);
    res.status(201).json({ token, user: { _id: user._id, name: user.name, email: user.email, plan: user.plan, avatar: user.avatar, instagram: user.instagram } });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.json({ token, user: { _id: user._id, name: user.name, email: user.email, plan: user.plan, avatar: user.avatar, instagram: user.instagram } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token  = crypto.randomBytes(32).toString('hex');
    user.resetToken       = token;
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
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ error: 'Token and new password are required.' });

    const user = await User.findOne({ resetToken: token, resetTokenExpiry: { $gt: Date.now() } });
    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired.' });

    user.password         = password;
    user.resetToken       = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/google
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// GET /auth/google/callback
router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: process.env.FRONTEND_URL + '/pages/auth/login.html?error=google' }),
  (req, res) => {
    const token = makeToken(req.user);
    res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/oauth-callback.html?token=${token}&provider=google`);
  }
);

// GET /auth/instagram/url — return Instagram OAuth URL
router.get('/instagram/url', async (req, res) => {
  try {
    const clientId    = process.env.INSTAGRAM_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.INSTAGRAM_REDIRECT_URI);
    const scope       = encodeURIComponent('instagram_business_basic');
    const url = `https://www.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&response_type=code`;
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/instagram/callback — exchange code for token
router.get('/instagram/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code)
      return res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?error=cancelled`);

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

    // Get profile info using new Business API
    const profileRes = await axios.get(
      `https://graph.instagram.com/v19.0/me?fields=id,username,profile_picture_url,name&access_token=${long_lived_token}`
    );
    const { username, profile_picture_url, name } = profileRes.data;

    const igData = encodeURIComponent(JSON.stringify({
      accessToken: long_lived_token,
      userId:      user_id,
      username,
      name:        name || username,
      profilePic:  profile_picture_url || ''
    }));

    res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?igData=${igData}`);
  } catch (err) {
    console.error('Instagram callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}/pages/oauth/instagram-callback.html?error=failed`);
  }
});

module.exports = router;
