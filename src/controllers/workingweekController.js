import WorkingWeek from "../models/WorkingWeek.js";
import { handleAsync } from "../utils/handleAsync.js";
import WorkShift from "../models/WorkShift.js";

// Get Global Working Week
export const getWorkingWeek = handleAsync(async (req, res, next) => {
  const workingWeek = await WorkingWeek.findOne();

  if (!workingWeek) {
    return res.status(200).json({
      status: "success",
      data: {
        workingWeek: null,
      },
    });
  }

  res.status(200).json({
    status: "success",
    data: {
      workingWeek,
    },
  });
});

// Update Global Working Week
export const updateWorkingWeek = handleAsync(async (req, res, next) => {
  const updatedWorkingWeek = await WorkingWeek.findOneAndUpdate({}, req.body, {
    new: true,
    runValidators: true,
    upsert: true,
  });

  const workingDays = {
    monday: updatedWorkingWeek.workingDays.monday,
    tuesday: updatedWorkingWeek.workingDays.tuesday,
    wednesday: updatedWorkingWeek.workingDays.wednesday,
    thursday: updatedWorkingWeek.workingDays.thursday,
    friday: updatedWorkingWeek.workingDays.friday,
    saturday: updatedWorkingWeek.workingDays.saturday,
    sunday: updatedWorkingWeek.workingDays.sunday,
  };

  await WorkShift.updateMany({}, { $set: { workingDays } });

  res.status(200).json({
    status: "success",
    data: {
      workingWeek: updatedWorkingWeek,
    },
  });
});
