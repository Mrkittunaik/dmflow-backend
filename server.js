// server.js  — DMFlow Express Backend
require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const passport   = require('passport');
const helmet     = require('helmet');
const cookieParser = require('cookie-parser');

const app = express();

// ── Security & parsing ─────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));

// Allow multiple frontend origins (comma-separated in FRONTEND_URL)
// e.g. FRONTEND_URL=https://dmflowapp.in,https://dmflowapp.pages.dev
const _allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

console.log('✅  Allowed CORS origins:', _allowedOrigins.length ? _allowedOrigins : '(none set — all origins blocked)');

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (_allowedOrigins.includes(origin)) return callback(null, true);
    // In development (no FRONTEND_URL set), allow all — never in production
    if (!process.env.FRONTEND_URL) return callback(null, true);
    console.warn('CORS blocked origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Passport (Google OAuth) ────────────────────────────────
require('./config/passport')(passport);
app.use(passport.initialize());

// ── Rate Limiting ───────────────────────────────────────────
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // max 100 requests per IP per window
  skipSuccessfulRequests: true,  // only failed attempts count — blocks brute force, not real users
  message: { error: 'Too many attempts, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                  // generous but still blocks scrapers/abuse
  message: { error: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});


// ── Routes ─────────────────────────────────────────────────
app.use('/webhook',       require('./routes/webhook'));   // Instagram webhook — NO rate limiter (Meta needs fast 200)
app.use('/auth',          authLimiter, require('./routes/auth'));
app.use('/api/user',      apiLimiter,  require('./routes/user'));
app.use('/api/automations', apiLimiter, require('./routes/automations'));
app.use('/api/templates', apiLimiter,  require('./routes/templates'));
app.use('/api/analytics', apiLimiter,  require('./routes/analytics'));
app.use('/api/contacts',  apiLimiter,  require('./routes/contacts'));
app.use('/api/keywords',  apiLimiter,  require('./routes/keywords'));
app.use('/api/inbox',     apiLimiter,  require('./routes/inbox'));
app.use('/api/ig',        apiLimiter,  require('./routes/ig'));
app.use('/api/billing',   apiLimiter,  require('./routes/billing'));

// ── Careers / HR routes ────────────────────────────────────
app.use('/api/hr',     apiLimiter, require('./routes/hr'));       // HR login + management
app.use('/api/roles',  apiLimiter, require('./routes/roles'));    // Public: active job listings
app.use('/api/joiner', apiLimiter, require('./routes/joiner'));   // Candidate: verify ID + submit form

// ── Health check ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── 404 ────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

// ── Error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── DB + Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 4000;

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅  MongoDB connected');
    // Seed default templates if DB is empty
    await require('./seeds/templates').seed();
    app.listen(PORT, () => console.log(`🚀  Server running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('❌  MongoDB connection failed:', err.message);
    process.exit(1);
  });
