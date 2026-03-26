import mongoose from 'mongoose';

const scheduleHolidaySchema = new mongoose.Schema({
  // ... your existing fields (title, assignedTo, etc.) ...

  // THE SIMPLE NEW FIELD
  holidayAction: {
    type: String,
    enum: ['BEFORE', 'AFTER'], // Simple: Do it Before the holiday or After?
    default: 'AFTER',          // Default behavior
    required: true
  },

  // ... rest of your schema
});

// ... exports
const ScheduleHolidayTask = mongoose.model('ScheduleHolidayTask', scheduleHolidaySchema);
export default ScheduleHolidayTask;
