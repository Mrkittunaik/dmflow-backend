// models/Thread.js  — NEW (not in old backend)
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  from:    { type: String, enum: ['user','contact'], required: true },
  text:    { type: String, required: true },
  sentAt:  { type: Date, default: Date.now },
  igMsgId: { type: String },
});

const threadSchema = new mongoose.Schema({
  userId:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contactId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  igUserId:            { type: String },
  username:            { type: String, trim: true },
  name:                { type: String, trim: true },
  avatar:              { type: String },
  messages:            [messageSchema],
  lastMessage:         { type: String },
  lastAt:              { type: Date, default: Date.now },
  unread:              { type: Boolean, default: true },
  unreadCount:         { type: Number, default: 0 },
  automationTriggered: { type: Boolean, default: false },
}, { timestamps: true });

threadSchema.index({ userId: 1, lastAt: -1 });

module.exports = mongoose.model('Thread', threadSchema);
