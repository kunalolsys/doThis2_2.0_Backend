import mongoose from 'mongoose';

const FmsInstanceTaskSchema = new mongoose.Schema({
  fmsInstanceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FmsInstance',
    required: true,
    index: true
  },
  fmsTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FmsTask',
    required: true
  },
  taskId: String, // Copy from template
  description: String,
  departmentOfAssignToUser: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  frequency: String,
  xValue: Number,
  isDependent: Boolean,
  dependentOn: String,
  startTimeSetting: String,
  decisionStep: Boolean,
  ifTrueStep: String,
  elseStep: String,
  // Runtime
  plannedStartDate: Date,
  plannedDueDate: Date,
  actualStartDate: Date,
  actualCompleteDate: Date,
  status: {
    type: String,
    enum: ['Upcoming', 'Pending', 'Delayed', 'Overdue', 'Completed'],
    default: 'Upcoming'
  },
  delayDays: Number,
  waitingForParent: Boolean,
  decisionResult: { type: String, enum: ['true', 'false'] }, // Runtime decision
}, { timestamps: true });

FmsInstanceTaskSchema.index({ fmsInstanceId: 1, taskId: 1 });
FmsInstanceTaskSchema.index({ fmsInstanceId: 1, status: 1 });

export default mongoose.model('FmsInstanceTask', FmsInstanceTaskSchema);

