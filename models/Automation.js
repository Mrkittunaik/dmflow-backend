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

  // Stats
  stats: {
    triggered:    { type: Number, default: 0 },
    dmsSent:      { type: Number, default: 0 },
    repliesSent:  { type: Number, default: 0 },
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
