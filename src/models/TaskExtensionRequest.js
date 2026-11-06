import mongoose from "mongoose";

const taskExtensionRequestSchema = new mongoose.Schema(
  {
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reportingManager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    currentDueDate: {
      type: Date,
      required: true,
    },
    requestedExtensionDays: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

export default mongoose.model(
  "TaskExtensionRequest",
  taskExtensionRequestSchema,
);
