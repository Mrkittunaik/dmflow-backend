// server.js  — DMFlow Express Backend
require('dotenv').config();

const express      = require('express');
const mongoose     = require('mongoose');
const cors         = require('cors');
const passport     = require('passport');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');

const app = express();

// ── Security & parsing ─────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));

const _allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

console.log('✅  Allowed CORS origins:', _allowedOrigins.length ? _allowedOrigins : '(none set — all origins blocked)');

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (_allowedOrigins.includes(origin)) return callback(null, true);
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

// ── Activity tracker — must be BEFORE routes so every real request is counted
let _lastUserActivityAt = Date.now();
app.use((req, res, next) => {
  const isSelfPing = req.headers['x-self-ping'] === '1';
  if (!isSelfPing && req.path !== '/health') {
    _lastUserActivityAt = Date.now();
    // If self-ping was paused, restart it now that a real user is back
    if (typeof _resumeSelfPing === 'function') _resumeSelfPing();
  }
  next();
});

// ── Rate Limiting ───────────────────────────────────────────
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Routes ─────────────────────────────────────────────────
app.use('/webhook',         require('./routes/webhook'));   // No rate limiter — Meta needs fast 200
app.use('/auth',            authLimiter, require('./routes/auth'));
app.use('/api/user',        apiLimiter,  require('./routes/user'));
app.use('/api/automations', apiLimiter,  require('./routes/automations'));
app.use('/api/templates',   apiLimiter,  require('./routes/templates'));
app.use('/api/analytics',   apiLimiter,  require('./routes/analytics'));
app.use('/api/contacts',    apiLimiter,  require('./routes/contacts'));
app.use('/api/keywords',    apiLimiter,  require('./routes/keywords'));
app.use('/api/inbox',       apiLimiter,  require('./routes/inbox'));
app.use('/api/ig',          apiLimiter,  require('./routes/ig'));
app.use('/api/billing',     apiLimiter,  require('./routes/billing'));
app.use('/api/hr',          apiLimiter,  require('./routes/hr'));
app.use('/api/roles',       apiLimiter,  require('./routes/roles'));
app.use('/api/joiner',      apiLimiter,  require('./routes/joiner'));

// ── TEMP DEBUG — remove after fixing ───────────────────────
app.get('/debug-ig', async (req, res) => {
  try {
    const User = require('./models/User');
    const users = await User.find(
      {},
      { email: 1, 'instagram.userId': 1, 'instagram.username': 1, 'instagram.connected': 1, 'instagram.webhookSubscribed': 1 }
    );
    res.json(users);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  let queueStatus = {};
  try { queueStatus = require('./services/dmQueue').getStatus(); } catch(e) {}
  res.json({ status: 'ok', ts: new Date(), queue: queueStatus });
});

// ── 404 ─────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── DB + Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 4000;

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅  MongoDB connected');
    await require('./seeds/templates').seed();
    require('./services/dmQueue').startProcessor();

    app.listen(PORT, () => {
      console.log(`🚀  Server running on http://localhost:${PORT}`);

      const BACKEND_URL   = process.env.BACKEND_URL || `http://localhost:${PORT}`;
      const IDLE_STOP_MS  = 60 * 60 * 1000;
      const PING_INTERVAL = 10 * 60 * 1000;
      const axios         = require('axios');
      let _pingTimer      = null;
      let _pingPaused     = false;

      function schedulePing() {
        _pingTimer = setTimeout(async () => {
          _pingTimer = null;
          const idleMs = Date.now() - _lastUserActivityAt;
          if (idleMs >= IDLE_STOP_MS) {
            _pingPaused = true;
            console.log('💤  Self-ping paused — no user activity for 1 hr');
            return;
          }
          try {
            await axios.get(`${BACKEND_URL}/health`, {
              timeout: 10000,
              headers: { 'x-self-ping': '1' },
            });
            console.log('🔄  Self-ping OK');
          } catch (e) {
            console.warn('⚠️  Self-ping failed:', e.message);
          }
          schedulePing();
        }, PING_INTERVAL);
      }

      global._resumeSelfPing = function() {
        if (_pingPaused && !_pingTimer) {
          _pingPaused = false;
          console.log('▶️  Self-ping resumed — user activity detected');
          schedulePing();
        }
      };

      schedulePing();
    });
  })
  .catch(err => {
    console.error('❌  MongoDB connection failed:', err.message);
    process.exit(1);
  });
