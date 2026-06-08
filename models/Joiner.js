// models/Joiner.js
const mongoose = require('mongoose');

// File sub-document (stored as binary in Mongo — fine for < 5MB docs)
const fileSchema = new mongoose.Schema({
  data:        { type: Buffer },
  contentType: { type: String },
  filename:    { type: String },
  size:        { type: Number },
}, { _id: false });

const joinerSchema = new mongoose.Schema({
  joiningId: { type: String, required: true, uppercase: true },

  // Internship info (from the JoiningSlot)
  role:      { type: String },
  stipend:   { type: String },
  duration:  { type: String },
  startDate: { type: String },
  mode:      { type: String },

  // ── Step 1: Personal ───────────────────────────────────────
  name:    { type: String, required: true, trim: true },
  dob:     { type: String },
  phone:   { type: String },
  email:   { type: String },
  address: { type: String },
  devices: { type: String },   // e.g. "Mobile, Laptop"

  // ── Step 2: College ────────────────────────────────────────
  college:    { type: String },
  branch:     { type: String },
  year:       { type: String },
  enrollment: { type: String },

  // ── Step 3: Documents ──────────────────────────────────────
  passportPhoto: fileSchema,
  collegeId:     fileSchema,
  aadhar:        fileSchema,   // single ID proof
  noc:           fileSchema,   // NOC from college

  // ── Step 4: Bank ───────────────────────────────────────────
  accname:  { type: String },
  accnoMasked: { type: String },   // store only last 4 digits
  ifsc:     { type: String },
  bankname: { type: String },
  acctype:  { type: String },

  // ── Step 5: Signature ──────────────────────────────────────
  signature: { type: String },   // canvas dataURL (base64 PNG)

  // ── Status ─────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  hrNote:      { type: String, default: '' },
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Joiner', joinerSchema);
