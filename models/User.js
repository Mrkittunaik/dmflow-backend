// models/User.js
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
// ── Instagram token encryption helpers ─────────────────────
function encryptToken(plain) {
  if (!plain || !process.env.TOKEN_SECRET) return plain;
  const crypto = require('crypto');
  const iv     = crypto.randomBytes(16);
  const key    = crypto.scryptSync(process.env.TOKEN_SECRET, process.env.TOKEN_SALT || 'dmflow', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return iv.toString('hex') + ':' + cipher.update(plain, 'utf8', 'hex') + cipher.final('hex');
}
function decryptToken(enc) {
  if (!enc || !process.env.TOKEN_SECRET || !enc.includes(':')) return enc;
  const crypto = require('crypto');
  const [ivHex, encrypted] = enc.split(':');
  const key     = crypto.scryptSync(process.env.TOKEN_SECRET, process.env.TOKEN_SALT || 'dmflow', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}
const userSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:     { type: String },          // null for Google/Facebook-only users
  googleId:     { type: String },
  avatar:       { type: String },
  plan:         { type: String, enum: ['free','pro','business'], default: 'free' },
  dmsSentMonth: { type: Number, default: 0 },
  dmLimit:      { type: Number, default: 500 },
  // Facebook connection
  facebook: {
    id:      { type: String },
    name:    { type: String },
    email:   { type: String },
    picture: { type: String },
  },
  // Instagram connection
  instagram: {
    connected:         { type: Boolean, default: false },
    userId:            { type: String },
    username:          { type: String },
    accessToken:       { type: String },
    tokenExpiry:       { type: Date },
    pageId:            { type: String },
    profilePic:        { type: String, default: '' },
    fullName:          { type: String },
    accountType:       { type: String },
    webhookSubscribed: { type: Boolean, default: false },
    webhookUserId:     { type: String },
    scopesGranted:     [{ type: String }],
  },
  // Reset token (for forgot password)
  resetToken:        { type: String },
  resetTokenExpiry:  { type: Date },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });
// Hash password before save
userSchema.pre('save', async function(next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});
userSchema.methods.comparePassword = function(plain) {
  return bcrypt.compare(plain, this.password);
};
// Reset monthly DM count (call from a cron job)
userSchema.methods.decryptIgToken = function() {
  return decryptToken(this.instagram?.accessToken);
};
// Encrypt token before save if modified
userSchema.pre('save', function(next) {
  if (this.isModified('instagram.accessToken') && this.instagram?.accessToken && !this.instagram.accessToken.includes(':')) {
    this.instagram.accessToken = encryptToken(this.instagram.accessToken);
  }
  next();
});
// Prevent the same Instagram account from being linked to more than one user at once.
userSchema.index(
  { 'instagram.userId': 1 },
  { unique: true, partialFilterExpression: { 'instagram.connected': true } }
);
userSchema.methods.resetMonthlyDms = function() {
  this.dmsSentMonth = 0;
  return this.save();
};
module.exports = mongoose.model('User', userSchema);
