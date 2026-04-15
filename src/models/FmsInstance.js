import mongoose from "mongoose";
import Counter from "./Counter.js";
import FmsTemplate from "./FmsTemplate.js";
import User from "./User.js";

const FmsInstanceSchema = new mongoose.Schema(
  {
    instanceId: { type: String, unique: true },
    fmsTemplateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsTemplate",
      required: true,
    },
    instanceName: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: Date,
    fmsDuration: {
      type: String,
      enum: ["Timeless", "Fixed Period"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "InProcess",
        "Upcoming",
        "Ongoing",
        "Completed",
        "Cancelled",
        "Onhold",
        "Stopped",
      ],
      default: "Upcoming",
    },
    // FmsInstanceSchema
    progress: {
      totalTasks: { type: Number, default: 0 },
      completedTasks: { type: Number, default: 0 },
      rate: { type: Number, default: 0 },
      lastUpdated: Date,
    },
    manager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    srManager: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isStopped: { type: Boolean, default: false },
    progress: {
      totalTasks: Number,
      completedTasks: Number,
      rate: Number,
      lastUpdated: Date,
    },
  },
  { timestamps: true },
);

// Auto instanceId
FmsInstanceSchema.pre("save", async function (next) {
  if (this.isNew && !this.instanceId) {
    const template = await FmsTemplate.findById(this.fmsTemplateId);
    const ym = new Date().toISOString().slice(2, 7).replace("-", "");
    const counter = await Counter.findByIdAndUpdate(
      `fmsInstance_${ym}`,
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
    this.instanceId = `${template.fmsId}-I${counter.seq.toString().padStart(4, "0")}`;
  }
  next();
});

export default mongoose.model("FmsInstance", FmsInstanceSchema);
