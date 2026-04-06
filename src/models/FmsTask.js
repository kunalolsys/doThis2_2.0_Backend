import mongoose from 'mongoose';
import Counter from './Counter.js';
import FmsTemplate from './FmsTemplate.js';
import User from './User.js';
import Department from './Department.js';

const FmsTaskSchema = new mongoose.Schema({
  fmsTemplateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FmsTemplate',
    required: true,
    index: true
  },
  taskId: {
    type: String,
    unique: true // FMS-1-01 unique in template
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  departmentOfAssignToUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true
  },
  assignedTo: { // Doer
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // BRD Task Table Fields
  frequency: {
    type: String,
    enum: [
      'Daily', 'Weekly', 'Monthly', 'Anytime',
      'Start+X in days', 'Start+X in hours',
      'D+X',
      'Task+X in days', 'Task-X in days',
      'Task+X in hours', 'Task-X in hours',
      'Event+X in days', 'Event-X in days',
      'Event+X in hours', 'Event-X in hours'
    ],
    required: true
  },
  xValue: Number,
  isDependent: {
    type: Boolean,
    default: false
  },
  dependentOn: String, // 'FMS-1-01' - validated to ref
  startTimeSetting: {
    type: String,
    enum: ['planned-to-planned', 'actual-to-planned']
  },
  decisionStep: {
    type: Boolean,
    default: false
  },
  ifTrueStep: String,
  elseStep: String,
  taskEndDays: Number,
  // Computed
  startDate: Date,
  dueDate: Date,
  status: {
    type: String,
    enum: ['Upcoming', 'Pending', 'Delayed', 'Overdue', 'Completed'],
    default: 'Upcoming'
  },
  waitingForParent: { type: Boolean, default: false },
  // Modals
  checklist: [{
    text: { type: String, required: true },
    completed: { type: Boolean, default: false }
  }],
  createForm: mongoose.Schema.Types.Mixed,
  // Audit
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// Indexes
FmsTaskSchema.index({ fmsTemplateId: 1, taskId: 1 });
FmsTaskSchema.index({ fmsTemplateId: 1, status: 1 });

// BRD Conditional Validation
FmsTaskSchema.pre('validate', function(next) {
  if (this.isDependent && !this.dependentOn) {
    return next(new Error('Dependent task requires Dependent On'));
  }
  if (this.decisionStep) {
    if (!this.ifTrueStep || !this.elseStep) {
      return next(new Error('Decision requires If True/Else steps'));
    }
  }
  next();
});

// Sequential taskId + dep resolution
FmsTaskSchema.pre('save', async function(next) {
  if (this.isNew) {
    // FMS-X-01 format
    const template = await FmsTemplate.findById(this.fmsTemplateId);
    const seq = await Counter.findByIdAndUpdate(
      `fmsTask_${this.fmsTemplateId}`,
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    this.taskId = `${template.fmsId}-${seq.seq.toString().padStart(2, '0')}`;

    // Resolve dependentOn → ObjectId
    if (this.dependentOn) {
      const depTask = await FmsTask.findOne({ 
        fmsTemplateId: this.fmsTemplateId,
        taskId: this.dependentOn 
      });
      if (!depTask) return next(new Error(`Dep "${this.dependentOn}" not found`));
      this.dependencyConfig.taskDependent = depTask._id;
    }
  }
  next();
});

export default mongoose.model('FmsTask', FmsTaskSchema);

