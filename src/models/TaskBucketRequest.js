import mongoose from "mongoose";

const TaskBucketRequestSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
    },
    startDate: {
      type: Date,
      default: null,
    },

    taskEndDays: {
      type: Number,
      default: null,
    },
    attachmentFile: {
      type: [String],
      default: [],
    },
    location: {
      type: String,
      required: true,
      trim: true,
    },

    // =====================================================
    // SUBMITTER DETAILS
    // =====================================================

    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    userAgent: {
      type: String,
      default: "",
    },

    // =====================================================
    // STATUS
    // =====================================================

    status: {
      type: String,
      enum: ["Pending", "Converted", "Rejected"],
      default: "Pending",
    },

    convertedTaskBucket: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TaskBucket",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("TaskBucketRequest", TaskBucketRequestSchema);
