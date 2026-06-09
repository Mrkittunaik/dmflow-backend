// models/JoiningSlot.js
// HR generates a unique 8-char ID for each selected candidate.
// Candidate enters this ID on the careers page to unlock the joining form.
const mongoose = require('mongoose');

const joiningSlotSchema = new mongoose.Schema({
  joiningId:    { type: String, required: true, unique: true, uppercase: true },  // e.g. DMFL1A2B
  roleId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
  role:         { type: String },         // snapshot at time of generation
  stipend:      { type: String },
  duration:     { type: String },
  startDate:    { type: String },
  mode:         { type: String },
  offerLetter:  { type: String },         // custom offer letter text from HR
  certTemplate: { type: String },         // certificate template text from HR
  used:         { type: Boolean, default: false },   // true after candidate submits
  expiresAt:    { type: Date },           // optional expiry
  createdBy:    { type: String, default: 'HR' },
}, { timestamps: true });

module.exports = mongoose.model('JoiningSlot', joiningSlotSchema);
