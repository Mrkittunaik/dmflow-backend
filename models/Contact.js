// models/Contact.js  — NEW (not in old backend)
const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  igUserId:     { type: String },
  username:     { type: String, trim: true },
  name:         { type: String, trim: true },
  avatar:       { type: String },
  email:        { type: String, trim: true, lowercase: true },
  tags:         [{ type: String }],
  notes:        { type: String },
  dmCount:      { type: Number, default: 0 },
  lastContact:  { type: Date },
  source:       { type: String, enum: ['keyword','story','comment','manual','dm'], default: 'manual' },
  optedOut:     { type: Boolean, default: false },
}, { timestamps: true });

contactSchema.index({ userId: 1, igUserId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Contact', contactSchema);
