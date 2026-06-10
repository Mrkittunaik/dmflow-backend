// models/Automation.js
const mongoose = require('mongoose');

const automationSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:       { type: String, default: 'Untitled Automation' },
  active:     { type: Boolean, default: false },
  type:       {
    type: String,
    enum: [
      'keyword_dm',          // old name (kept for backwards compat)
      'comment_reply',       // old name
      'story_dm',            // old name
      'email_collect',       // old name
      'discount_code',
      'auto_reply_comment',  // new frontend builder type
      'story_reaction_dm',   // new frontend builder type
      'collect_email',       // new frontend builder type
      'live_reply',          // new frontend builder type
      'product_link_dm',     // new frontend builder type
    ],
    default: 'keyword_dm',
  },

  // Extra fields sent by new builder types (stored as-is, validated loosely)
  applyAll:    { type: Boolean, default: false },  // true = applies to ALL posts/reels
  mediaId:     { type: String, default: '' },
  mediaUrl:    { type: String, default: '' },
  mediaType:   { type: String, default: '' }, // 'IMAGE' or 'REEL'
  keyword:     { type: String, default: '' },
  keywords:    [{ type: String }],
  commentReply:{ type: String, default: '' },
  dmEnabled:   { type: Boolean },
  dmText:      { type: String, default: '' },
  firstDm:     { type: String, default: '' },
  thankyouDm:  { type: String, default: '' },
  discountCode:{ type: String, default: '' },
  linkEnabled: { type: Boolean },

  // Trigger config
  trigger: {
    onComment:      { type: Boolean, default: true },
    onStoryReply:   { type: Boolean, default: false },
    onDmKeyword:    { type: Boolean, default: false },
    keywords:       [{ type: String }],           // e.g. ['LINK','INFO']
    allComments:    { type: Boolean, default: false }, // true = fire on ALL comments
    anyComment:     { type: Boolean, default: false }, // alias for allComments
    matchAll:       { type: Boolean, default: false }, // false = any keyword
  },

  // What to do
  actions: {
    // Auto-reply to the public comment
    commentReply: {
      enabled: { type: Boolean, default: false },
      text:    { type: String, default: '' },
    },
    // Send a DM
    dm: {
      enabled:  { type: Boolean, default: true },
      text:     { type: String, default: '' },
      linkTitle:{ type: String, default: '' },
      linkUrl:  { type: String, default: '' },
    },
  },

  // ── Advanced DM Settings (set in builder Step 6) ───────────────────────────
  // These are enforced by services/dmQueue.js, NOT by the API limiter.
  settings: {
    // Seconds to wait after trigger before sending DM (0 = instant)
    // Options shown in UI: 0, 30, 60, 300, 600
    dmDelay: { type: Number, default: 0, min: 0, max: 3600 },

    // Max DMs this automation can send per hour.
    // Instagram hard cap is 200/hr. We default to 100 to stay safe.
    maxDmsPerHour: { type: Number, default: 100, min: 1, max: 200 },

    // Block sending duplicate DMs to the same person from this automation
    skipDuplicate: { type: Boolean, default: true },

    // How long (hours) before the same person can receive this DM again
    // Used only when skipDuplicate is true
    duplicateWindowHours: { type: Number, default: 24, min: 1, max: 168 }, // max 7 days
  },

  // Stats
  stats: {
    triggered:       { type: Number, default: 0 },
    dmsSent:         { type: Number, default: 0 },
    repliesSent:     { type: Number, default: 0 },
    failed:          { type: Number, default: 0 },
    lastTriggeredAt: { type: Date, default: null },
    // Rolling log of last 20 comment triggers (for live view in builder)
    recentLog: [{
      at:   { type: Date },
      text: { type: String },   // first 80 chars of the comment
      from: { type: String },   // commenter IG user ID
      live: { type: Boolean, default: false },
    }],
    // Daily log for analytics chart — each entry: { date: Date, dmsSent: Number }
    dailyLog: [{
      date:     { type: Date, required: true },
      dmsSent:  { type: Number, default: 0 },
    }],
  },

  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
});

automationSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Automation', automationSchema);
