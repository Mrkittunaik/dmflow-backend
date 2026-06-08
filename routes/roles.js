// models/Role.js
const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  title:           { type: String, required: true, trim: true },
  stipend:         { type: String, default: 'Unpaid', trim: true },
  duration:        { type: String, default: '', trim: true },
  skills:          [{ type: String, trim: true }],
  mode:            { type: String, enum: ['Remote', 'Hybrid', 'Onsite'], default: 'Remote' },
  active:          { type: Boolean, default: true },
  formLink:        { type: String, default: '' },
  certTemplateImg: { type: String, default: '' },  // base64 dataURL of certificate template image
}, { timestamps: true });

module.exports = mongoose.model('Role', roleSchema);
