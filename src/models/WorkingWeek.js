import mongoose from "mongoose";

const WorkingWeekSchema = new mongoose.Schema(
  {
    workingDays: {
      monday: { type: Boolean, default: true },
      tuesday: { type: Boolean, default: true },
      wednesday: { type: Boolean, default: true },
      thursday: { type: Boolean, default: true },
      friday: { type: Boolean, default: true },
      saturday: { type: Boolean, default: false },
      sunday: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

const WorkingWeek = mongoose.model("WorkingWeek", WorkingWeekSchema);
export default WorkingWeek;
