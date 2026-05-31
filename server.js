// server.js  — DMFlow Express Backend
require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const passport   = require('passport');
const helmet     = require('helmet');

const app = express();

// ── Security & parsing ─────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin:      process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Passport (Google OAuth) ────────────────────────────────
require('./config/passport')(passport);
app.use(passport.initialize());

// ── Rate Limiting ───────────────────────────────────────────
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // max 20 requests per IP per window
  message: { error: 'Too many attempts, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});


// ── Routes ─────────────────────────────────────────────────
app.use('/auth',          authLimiter, require('./routes/auth'));
app.use('/api/user',      require('./routes/user'));
app.use('/api/automations', require('./routes/automations'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/contacts',  require('./routes/contacts'));
app.use('/api/keywords',  require('./routes/keywords'));
app.use('/api/inbox',     require('./routes/inbox'));
app.use('/api/ig',        require('./routes/ig'));
app.use('/api/billing',   require('./routes/billing'));

// ── Health check ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── 404 ────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

// ── Error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error.' });
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
