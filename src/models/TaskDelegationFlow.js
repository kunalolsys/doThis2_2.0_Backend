import mongoose from "mongoose";

const TaskDelegationFlowSchema = new mongoose.Schema(
  {
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
    },

    level: {
      type: Number,
      default: 1,
    },

    fromUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    toUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    assignedDepartment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      default: null,
    },

    remarks: {
      type: String,
      default: "",
    },

    actionType: {
      type: String,
      enum: ["Created", "Forwarded", "Assigned", "Rejected"],
      default: "Forwarded",
    },

    actionDate: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("TaskDelegationFlow", TaskDelegationFlowSchema);
