import mongoose from "mongoose";

const WorkingWeekSchema = mongoose.Schema({
 workingDays: {
      monday: {
        type: Boolean,
        default: false
      },
      tuesday: {
        type: Boolean,
        default: false
      },
      wednesday: {
        type: Boolean,
        default: false
      },
      thursday: {
        type: Boolean,
        default: false
      },
      friday: {
        type: Boolean,
        default: false
      },
      saturday: {
        type: Boolean,
        default: false
      },
      sunday: {
        type: Boolean,
        default: false
      }
    }
  },
  {
    timestamps: true // Automatically adds createdAt and updatedAt
  }
);

const WorkingWeek = mongoose.model('WorkingWeek', WorkingWeekSchema);
export default WorkingWeek