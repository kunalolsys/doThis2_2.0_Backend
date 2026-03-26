import ScheduleHolidayTask from '../models/ScheduleHolidayTask.js';
import {handleAsync} from '../utils/handleAsync.js';
import AppError from '../utils/AppError.js';

export const getScheduleHolidayTask = handleAsync(async (req, res, next) => {
  const task = await ScheduleHolidayTask.findOne().sort({ createdAt: -1 });

  res.status(200).json({
    status: 'success',
    data: task,
  });
});

export const createScheduleHolidayTask = handleAsync(async (req, res, next) => {
  const { holidayAction } = req.body;

  if (!['BEFORE', 'AFTER'].includes(holidayAction)) {
    return next(new AppError('Invalid holidayAction. Must be BEFORE or AFTER.', 400));
  }

  // Use findOneAndUpdate with upsert: true to create or update the setting
  const updatedScheduledTask = await ScheduleHolidayTask.findOneAndUpdate(
    {}, // An empty filter will match the first document found
    { holidayAction },
    { new: true, upsert: true, sort: { createdAt: -1 } }
  );

  res.status(201).json({
    status: 'success',
    data: {
      task: updatedScheduledTask,
    },
  });
});
