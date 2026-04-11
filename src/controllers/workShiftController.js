import WorkShift from "../models/WorkShift.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import WorkingWeek from "../models/WorkingWeek.js";
import User from "../models/User.js";

// Get All WorkShifts
export const getAllWorkShifts = handleAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search } = req.body;
  const filter = { isDeleted: false };

  if (search) {
    filter.$or = [{ name: { $regex: search, $options: "i" } }];
  }
  const skip = (page - 1) * limit;

  // ✅ Total count (for frontend pagination)
  const total = await WorkShift.countDocuments(filter);

  // ✅ Fetch users
  const workShifts = await WorkShift.find(filter)
    .skip(skip)
    .limit(Number(limit))
    .sort({ createdAt: -1 });

  return res.status(200).json({
    success: true,
    data: workShifts,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    },
  });
});
export const getAllShiftsForDrops = handleAsync(async (req, res) => {
  // 🔥 NO PAGINATION HERE
  const workShifts = await WorkShift.find({ isDeleted: false });

  return res.status(200).json({
    success: true,
    data: workShifts,
  });
});
export const exportWorkShifts = handleAsync(async (req, res) => {
  const { search } = req.body;

  const filter = { isDeleted: false };

  if (search) {
    filter.$or = [{ name: { $regex: search, $options: "i" } }];
  }

  // 🔥 NO PAGINATION HERE
  const workShifts = await WorkShift.find(filter);

  return res.status(200).json({
    success: true,
    data: workShifts,
  });
});
// Create WorkShift
export const createWorkShift = handleAsync(async (req, res, next) => {
  const { name, startTime, endTime } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return next(new AppError("Work shift name is required", 400));
  }
  if (!startTime) {
    return next(new AppError("Start time is required", 400));
  }
  if (!endTime) {
    return next(new AppError("End time is required", 400));
  }

  // Check if work shift already exists
  const existingWorkShift = await WorkShift.findOne({
    startTime,
    endTime,
    isDeleted: false,
  });
  if (existingWorkShift) {
    return next(new AppError("Work shift already exists", 400));
  }
  const defaultWorkingWeek = await WorkingWeek.findOne({ isDefault: true });

  if (!defaultWorkingWeek) {
    return next(new AppError("No default working week found", 400));
  }
  const workShift = await WorkShift.create({
    name: name.trim(),
    startTime,
    endTime,
    workingDays: defaultWorkingWeek.workingDays,
  });

  res.status(201).json({
    status: "success",
    message: "Work shift created successfully",
    workShift,
  });
});

// Get WorkShift by ID
export const getWorkShiftById = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const workShift = await WorkShift.findById(id);
  if (!workShift) {
    return next(new AppError("Work shift not found", 404));
  }
  res.status(200).json({
    status: "success",
    workShift,
  });
});

// Update WorkShift
export const updateWorkShift = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, startTime, endTime } = req.body;
  const workShift = await WorkShift.findById(id);
  if (!workShift) {
    return next(new AppError("Work shift not found", 404));
  }
  if (name) {
    workShift.name = name;
  }
  if (startTime) {
    workShift.startTime = startTime;
  }
  if (endTime) {
    workShift.endTime = endTime;
  }
  await workShift.save();
  res.status(200).json({
    status: "success",
    message: "Work shift updated successfully",
    workShift,
  });
});

// Delete WorkShift
export const deleteWorkShift = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const currentUserId = req.cookies.userId;

  const workShift = await WorkShift.findById(id);
  if (!workShift) {
    return next(new AppError("WorkShift not found", 404));
  }
  if (workShift.isDeleted) {
    return next(new AppError("WorkShift already deleted", 400));
  }

  // Check if any users are linked to this department
  const userCount = await User.countDocuments({
    assignShift: id,
    isDeleted: false, // ✅ exclude deleted users
  });
  if (userCount > 0) {
    return next(
      new AppError(
        `Cannot delete Workshift. ${userCount} user(s) are still linked. Unlink them first.`,
        400,
      ),
    );
  }

  workShift.isDeleted = true;
  workShift.deletedBy = currentUserId;
  await workShift.save();

  res.status(200).json({
    status: "success",
    message: "Work shift deleted successfully",
  });
});
