import mongoose from "mongoose";

const FmsInstanceTaskSchema = new mongoose.Schema(
  {
    fmsInstanceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsInstance",
      required: true,
      index: true,
    },
    fmsTaskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsTask",
      required: true,
    },
    taskId: { type: String, required: true, index: true },
    description: { type: String, required: true },
    departmentOfAssignToUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    frequency: { type: String, required: true },
    xValue: Number,
    isDependent: { type: Boolean, default: false },
    dependentOn: String,
    startTimeSetting: String,
    decisionStep: { type: Boolean, default: false },
    ifTrueStep: String,
    elseStep: String,
    taskEndDays: { type: Number, default: 0 },

    // FINAL RUNTIME DATES (computed at launch)
    plannedStartDate: { type: Date, required: true },
    plannedDueDate: Date,

    // ACTUAL progress
    actualStartDate: Date,
    actualCompleteDate: Date,
    status: {
      type: String,
      enum: ["Upcoming", "Pending", "Delayed", "Overdue", "Completed"],
      default: "Upcoming",
      index: true,
    },
    delayDays: Number,
    waitingForParent: { type: Boolean, default: false },
    decisionResult: String,
    isVisible: { type: Boolean, default: false }, // Shift-aware visibility

    // Audit
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

FmsInstanceTaskSchema.index({ fmsInstanceId: 1, taskId: 1 });
FmsInstanceTaskSchema.index({ fmsInstanceId: 1, status: 1 });
FmsInstanceTaskSchema.index({ assignedTo: 1, isVisible: 1 });

export default mongoose.model("FmsInstanceTask", FmsInstanceTaskSchema);
