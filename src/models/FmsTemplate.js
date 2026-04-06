import mongoose from 'mongoose';
import Counter from './Counter.js';
import User from './User.js';
import FmsTask from './FmsTask.js';
import FmsInstance from './FmsInstance.js';

const FmsTemplateSchema = new mongoose.Schema({
  fmsId: {
    type: String,
    unique: true,
    sparse: true, // Allow nulls
  },
  templateName: {
    type: String,
    required: [true, 'Template name required'],
    trim: true,
    maxLength: 100,
    unique: true, // Prevent duplicates as per user request
    index: true
  },
  description: {
    type: String,
    trim: true,
    maxLength: 500
  },
  fmsDuration: {
    type: String,
    enum: ['Timeless', 'Fixed Period'],
    required: true
  },
  endDate: Date,
  manager: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  srManager: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  tasks: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FmsTask'
  }] // Bidirectional ref to tasks
}, { timestamps: true });

// Indexes for performance
FmsTemplateSchema.index({ fmsId: 1 });
FmsTemplateSchema.index({ manager: 1 });
FmsTemplateSchema.index({ templateName: 1 }); // Explicit for queries

// BRD: Fixed Period → endDate required
FmsTemplateSchema.pre('validate', function(next) {
  if (this.fmsDuration === 'Fixed Period' && !this.endDate) {
    this.invalidate('endDate', 'End Date required for Fixed Period');
  }
  next();
});

// Auto FMS ID (FMS-YYMMNNNN)
FmsTemplateSchema.pre('save', async function(next) {
  if (this.isNew && !this.fmsId) {
    const now = new Date();
    const ym = `${now.getFullYear()%100}${(now.getMonth()+1).toString().padStart(2,'0')}`;
    
    const counter = await Counter.findByIdAndUpdate(
      { _id: `fms_${ym}` },
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    
    this.fmsId = `FMS-${ym}${counter.seq.toString().padStart(4,'0')}`;
  }
  next();
});

// Virtuals for stats
FmsTemplateSchema.virtual('taskCount', {
  ref: 'FmsTask',
  localField: '_id',
  foreignField: 'fmsTemplateId',
  count: true
});

FmsTemplateSchema.virtual('instanceCount', {
  ref: 'FmsInstance',
  localField: '_id',
  foreignField: 'fmsTemplateId',
  count: true
});

// Ensure virtuals in JSON
FmsTemplateSchema.set('toJSON', { virtuals: true });
FmsTemplateSchema.set('toObject', { virtuals: true });

export default mongoose.model('FmsTemplate', FmsTemplateSchema);

