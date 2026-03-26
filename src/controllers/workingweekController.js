import WorkingWeek from "../models/WorkingWeek.js";
import {handleAsync} from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
 
// Get the single working week configuration
export const getWorkingWeek = handleAsync(async (req, res, next) => {
  // Find the first (and only) working week document
  const workingWeek = await WorkingWeek.findOne();
 
  if (!workingWeek) {
    // If it doesn't exist, we can return a default or an empty object.
    // This prevents a 404 error on first load before it's been saved.
    return res.status(200).json({
      status: "success",
      data: {
        workingWeek: null // Frontend can handle this initial state
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
 
// Update (or create) the single working week configuration
export const updateWorkingWeek = handleAsync(async (req, res, next) => {
  // Find one document and update it. If it doesn't exist, create it (upsert: true).
  const updatedWorkingWeek = await WorkingWeek.findOneAndUpdate(
    {}, // Empty filter matches the first document
    req.body, // The req.body is already in the correct { workingDays: {...} } format
    {
      new: true,
      runValidators: true,
      upsert: true, // This is the key: creates a new doc if no match is found
    }
  );
 
  res.status(200).json({
    status: "success",
    data: {
      workingWeek: updatedWorkingWeek,
    },
  });
 });
 
