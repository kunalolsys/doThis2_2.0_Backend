import mongoose from 'mongoose';
import Counter from './Counter.js';
import FmsTemplate from './FmsTemplate.js';
import User from './User.js';

const FmsInstanceSchema = new mongoose.Schema({
  instanceId: { type: String, unique: true },
  fmsTemplateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FmsTemplate',
    required: true
  },
  instanceName: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: Date,
  status: {
    type: String,
    enum: ['Upcoming', 'Ongoing', 'Completed', 'Cancelled'],
    default: 'Upcoming'
  },
  manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  srManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

// Auto instanceId FMS-ID-LNNNN
FmsInstanceSchema.pre('save', async function(next) {
  if (this.isNew && !this.instanceId) {
    const template = await FmsTemplate.findById(this.fmsTemplateId);
    const ym = new Date().toISOString().slice(2,7).replace('-','');
    const counter = await Counter.findByIdAndUpdate(
      `fmsInstance_${template.fmsId}_${ym}`,
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    this.instanceId = `${template.fmsId}-L${counter.seq.toString().padStart(4,'0')}`;
  }
  next();
});

export default mongoose.model('FmsInstance', FmsInstanceSchema);

