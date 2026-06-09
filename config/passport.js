// config/passport.js
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const User = require('../models/User');

module.exports = function(passport) {

  // ── Serialize / Deserialize ────────────────────────────
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try { done(null, await User.findById(id)); }
    catch(e) { done(e); }
  });

  // ── Local (email + password) ───────────────────────────
  passport.use(new LocalStrategy(
    { usernameField: 'email', passwordField: 'password' },
    async (email, password, done) => {
      try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return done(null, false, { message: 'No account with that email.' });
        if (!user.password) return done(null, false, { message: 'This account uses Google login.' });
        const ok = await user.comparePassword(password);
        if (!ok) return done(null, false, { message: 'Wrong password.' });
        return done(null, user);
      } catch(e) { return done(e); }
    }
  ));

  // ── Google OAuth ───────────────────────────────────────
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL,
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails[0].value;
      let user = await User.findOne({ $or: [{ googleId: profile.id }, { email }] });
      if (user) {
        // Update googleId if they registered with email first
        if (!user.googleId) { user.googleId = profile.id; await user.save(); }
        return done(null, user);
      }
      // New user via Google
      user = await User.create({
        name:     profile.displayName,
        email,
        googleId: profile.id,
        avatar:   profile.photos?.[0]?.value,
      });
      return done(null, user);
    } catch(e) { return done(e); }
  }));
};
