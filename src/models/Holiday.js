// models/Holiday.js
import mongoose from 'mongoose';

const holidaySchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Note: `date` has `unique: true` on the field; no separate index declaration needed to avoid duplicates

export const Holiday = mongoose.model('Holiday', holidaySchema);