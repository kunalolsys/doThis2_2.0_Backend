import mongoose from "mongoose";

const workShiftSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    startTime: {
      type: String,
      required: [true, 'Start time is required'],
      // regex validation to ensure 24-hour format (00:00 to 23:59)
      match: [
        /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 
        'Please provide a valid time in HH:mm format'
      ] 
    },
    endTime: {
      type: String,
      required: [true, 'End time is required'],
      match: [
        /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 
        'Please provide a valid time in HH:mm format'
      ]
    },
    workingDays: {
      monday: { type: Boolean, default: false },
      tuesday: { type: Boolean, default: false },
      wednesday: { type: Boolean, default: false },
      thursday: { type: Boolean, default: false },
      friday: { type: Boolean, default: false },
      saturday: { type: Boolean, default: false },
      sunday: { type: Boolean, default: false },
    }
    // isDeleted:{
    //     type:Boolean,
    //     default:false
    // }
},{timestamps:true});

// Add Partial index for "name" where isDeleted is false
// workShiftSchema.index({ name: 1 }, {unique: true ,partialFilterExpression: { isDeleted: false } });

const WorkShift = mongoose.model('WorkShift', workShiftSchema);

export default WorkShift;