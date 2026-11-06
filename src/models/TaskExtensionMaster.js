import mongoose from "mongoose";

const taskExtensionMasterSchema = new mongoose.Schema(
  {
    daysBeforeDueDate: {
      type: Number,
      required: true,
      default: 2, // Example: Due date se 2 din pehle user ko button dikhega
    },
    maxExtensionDays: {
      type: Number,
      required: true,
      default: 3, // User maximum 3 din tak hi extend request daal sakta hai
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

export default mongoose.model("TaskExtensionMaster", taskExtensionMasterSchema);
