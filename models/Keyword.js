// models/Keyword.js  — NEW (not in old backend)
const mongoose = require('mongoose');

const keywordSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  word:          { type: String, required: true, trim: true, uppercase: true },
  replyText:     { type: String, default: '' },
  dmText:        { type: String, default: '' },
  active:        { type: Boolean, default: true },
  triggerCount:  { type: Number, default: 0 },
  lastTriggered: { type: Date },
  matchType:     { type: String, enum: ['exact','contains'], default: 'contains' },
}, { timestamps: true });

keywordSchema.index({ userId: 1, word: 1 }, { unique: true });

module.exports = mongoose.model('Keyword', keywordSchema);
