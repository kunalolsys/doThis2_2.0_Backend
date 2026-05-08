import mongoose from "mongoose";

const moduleSettingSchema = new mongoose.Schema(
  {
    moduleKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    isEnabled: {
      type: Boolean,
      default: true,
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model("ModuleSetting", moduleSettingSchema);

