import mongoose from "mongoose";

const TaskAudienceMasterSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    memberRole: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      default: null,
    },
    assignmentMode: {
      type: String,
      enum: ["Role", "Users"],
      required: true,
    },

    targetRole: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      default: null,
    },

    targetUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    isActive: {
      type: Boolean,
      default: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("TaskAudienceMaster", TaskAudienceMasterSchema);
