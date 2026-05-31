// models/Template.js
const mongoose = require('mongoose');

// Pre-built templates shown to users in the builder
const templateSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  description: { type: String },
  icon:        { type: String, default: '⚡' },
  badge:       { type: String },              // e.g. 'MOST POPULAR'
  type:        { type: String },
  trigger: {
    onComment:    Boolean,
    onStoryReply: Boolean,
    onDmKeyword:  Boolean,
    keywords:     [String],
  },
  actions: {
    commentReply: { enabled: Boolean, text: String },
    dm:           { enabled: Boolean, text: String, linkTitle: String, linkUrl: String },
  },
  order:  { type: Number, default: 0 },
});

module.exports = mongoose.model('Template', templateSchema);
