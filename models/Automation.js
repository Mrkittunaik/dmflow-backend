// models/Automation.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX #16: mediaId was a single String, but the builder UI lets a user select
// MULTIPLE posts/reels in the grid before saving. Sending an array into a
// String field caused silent cast failures / data corruption — automations
// would end up scoped to the wrong post(s), or to ALL posts, depending on how
// Mongoose happened to coerce the bad input. This rewrite makes "which
// post/reel this automation applies to" a first-class, strictly validated,
// array-based concept, with applyAll as an explicit separate switch.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

// ── Sub-schema: a single targeted post/reel ─────────────────────────────────
// Storing the full object (not just the ID) means the builder can re-render
// the selected post thumbnails without a second API round-trip to Instagram.
const targetMediaSchema = new mongoose.Schema({
  mediaId:   { type: String, required: true, trim: true },
  mediaType: { type: String, enum: ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM', 'REEL', ''], default: '' },
  mediaUrl:  { type: String, default: '' },   // thumbnail/permalink for builder UI
  caption:   { type: String, default: '' },   // first ~80 chars, for builder UI labels
}, { _id: false });

const automationSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:       { type: String, default: 'Untitled Automation', trim: true, maxlength: 120 },
  active:     { type: Boolean, default: false, index: true },
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
      'flow_dm',             // new frontend builder type
    ],
    default: 'keyword_dm',
  },

  // ── Media targeting (FIX #16) ───────────────────────────────────────────
  // applyAll = true            → matches every post/reel the account owns.
  // applyAll = false + media[] → matches ONLY the specific posts/reels listed.
  // applyAll = false + media[] empty → matches NOTHING (explicit, not a bug).
  applyAll: { type: Boolean, default: false },
  media:    {
    type: [targetMediaSchema],
    default: [],
    validate: {
      validator: function (arr) {
        // Hard cap — protects against a malformed frontend payload trying to
        // bulk-target hundreds of posts in one automation by accident.
        return Array.isArray(arr) && arr.length <= 50;
      },
      message: 'An automation can target at most 50 posts/reels.',
    },
  },

  // ── Legacy single-media fields ──────────────────────────────────────────
  // FIX #16: Kept ONLY for backwards compatibility with documents created
  // before this migration. New code must read/write via `media[]` above.
  mediaId:   { type: String, default: '' },
  mediaUrl:  { type: String, default: '' },
  mediaType: { type: String, default: '' },

  keyword:     { type: String, default: '', trim: true },
  keywords:    { type: [{ type: String, trim: true }], default: [] },
  commentReply:{ type: String, default: '', maxlength: 2200 },
  dmEnabled:   { type: Boolean },
  dmText:      { type: String, default: '', maxlength: 1000 },
  firstDm:     { type: String, default: '', maxlength: 1000 },
  thankyouDm:  { type: String, default: '', maxlength: 1000 },
  discountCode:{ type: String, default: '', trim: true },
  linkEnabled: { type: Boolean },

  // Trigger config
  trigger: {
    onComment:      { type: Boolean, default: true },
    onStoryReply:   { type: Boolean, default: false },
    onDmKeyword:    { type: Boolean, default: false },
    onMention:      { type: Boolean, default: false },
    keywords:       { type: [{ type: String, trim: true }], default: [] }, // e.g. ['LINK','INFO']
    allComments:    { type: Boolean, default: false }, // true = fire on ALL comments
    anyComment:     { type: Boolean, default: false }, // alias for allComments
    matchAll:       { type: Boolean, default: false }, // false = any keyword
  },

  // What to do
  actions: {
    // Auto-reply to the public comment
    commentReply: {
      enabled: { type: Boolean, default: false },
      text:    { type: String, default: '', maxlength: 2200 },
    },
    // Send a DM
    dm: {
      enabled:  { type: Boolean, default: true },
      text:     { type: String, default: '', maxlength: 1000 },
      linkTitle:{ type: String, default: '', maxlength: 80 },
      linkUrl:  {
        type: String,
        default: '',
        validate: {
          validator: (v) => !v || /^https?:\/\/.+/i.test(v),
          message: 'linkUrl must be a valid http(s) URL.',
        },
      },
    },
    // Flow DM (interactive buttons)
    flow: {
      firstMessage: { type: String, default: '', maxlength: 1000 },
      buttons: [{
        label:   { type: String, default: '', maxlength: 20 }, // IG quick-reply limit
        type:    { type: String, enum: ['reply', 'link'], default: 'reply' },
        keyword: { type: String, default: '' },
        replyDm: { type: String, default: '', maxlength: 1000 },
        linkUrl: { type: String, default: '' },
      }],
    },
  },

  // ── Advanced DM Settings (set in builder Step 6) ───────────────────────────
  // These are enforced by services/dmQueue.js, NOT by the API limiter.
  settings: {
    dmDelay:               { type: Number, default: 0, min: 0, max: 3600 },
    maxDmsPerHour:         { type: Number, default: 100, min: 1, max: 200 },
    skipDuplicate:         { type: Boolean, default: true },
    duplicateWindowHours:  { type: Number, default: 24, min: 1, max: 168 }, // max 7 days
  },

  // Stats
  stats: {
    triggered:       { type: Number, default: 0, min: 0 },
    dmsSent:         { type: Number, default: 0, min: 0 },
    repliesSent:     { type: Number, default: 0, min: 0 },
    failed:          { type: Number, default: 0, min: 0 },
    lastTriggeredAt: { type: Date, default: null },
    recentLog: [{
      at:   { type: Date },
      text: { type: String, maxlength: 80 },
      from: { type: String },
      live: { type: Boolean, default: false },
    }],
    dailyLog: [{
      date:    { type: Date, required: true },
      dmsSent: { type: Number, default: 0, min: 0 },
    }],
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// ── Indexes ──────────────────────────────────────────────────────────────────
// FIX #16: The webhook hot path filters by userId + active + type on every
// single comment event. Without a compound index this becomes a full
// collection scan once a user has more than a handful of automations.
automationSchema.index({ userId: 1, active: 1, type: 1 });
automationSchema.index({ userId: 1, 'media.mediaId': 1 });

// ── Validation: warn loudly if a non-applyAll automation has no media ──────
// FIX #16: "matches nothing" stays the correct, intentional behavior for an
// automation with applyAll=false and no targeted media — but that state is
// almost always a frontend bug (user picked posts, but they never reached
// the backend), so we log a clear warning instead of failing silently.
automationSchema.pre('validate', function (next) {
  if (!this.applyAll && (!this.media || this.media.length === 0) && !this.mediaId) {
    console.warn(
      `[Automation] ⚠️ Saving automation ${this._id || '(new)'} for user ${this.userId} ` +
      `with applyAll=false and NO targeted media. This automation will never trigger. ` +
      `If the user selected specific posts in the builder, check the frontend payload.`
    );
  }
  next();
});

automationSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// ── Instance method: does this automation apply to a given media ID? ──────
// FIX #16: Centralizes the matching logic that used to live duplicated
// inline in webhook.js (handleComment + handleStoryReply + handleMention all
// re-implemented their own version of this check). Single source of truth
// now — covers applyAll, the new media[] array, AND the legacy mediaId
// string field so old automations keep working unmodified.
automationSchema.methods.matchesMedia = function (mediaId) {
  if (this.applyAll) return true;
  if (!mediaId) return false;

  if (Array.isArray(this.media) && this.media.length > 0) {
    return this.media.some(m => m.mediaId === mediaId);
  }
  // Legacy fallback for documents created before FIX #16
  if (this.mediaId && this.mediaId !== '') {
    return this.mediaId === mediaId;
  }
  return false;
};

module.exports = mongoose.model('Automation', automationSchema);
