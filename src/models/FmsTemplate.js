import mongoose from 'mongoose';
import Counter from './Counter.js';
import User from './User.js';

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
    maxLength: 100
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
    required: true
  },
  srManager: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

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

export default mongoose.model('FmsTemplate', FmsTemplateSchema);

