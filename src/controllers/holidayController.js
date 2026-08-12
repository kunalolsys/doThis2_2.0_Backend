import { Holiday } from "../models/Holiday.js";
import AppError from "../utils/AppError.js";
import { handleAsync } from "../utils/handleAsync.js";

// Create Holiday
export const createHoliday = handleAsync(async (req, res, next) => {
  const { date, name, description, isGlobal, applicableDepartments } = req.body;

  const holiday = await Holiday.create({
    date,
    name,
    description,
    isGlobal: isGlobal ?? true,
    applicableDepartments: isGlobal ? [] : applicableDepartments || [],
  });

  const populatedHoliday = await Holiday.findById(holiday._id).populate(
    "applicableDepartments",
    "name",
  );

  res.status(201).json({
    status: "success",
    data: {
      holiday: populatedHoliday,
    },
  });
});

// Get All Holidays
export const getAllHolidays = handleAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search } = req.body;
  const filter = {};

  if (search) {
    filter.$or = [{ name: { $regex: search, $options: "i" } }];
  }
  const skip = (page - 1) * limit;

  const total = await Holiday.countDocuments(filter);

  const holidays = await Holiday.find(filter)
    .populate("applicableDepartments", "name")
    .skip(skip)
    .limit(Number(limit))
    .sort({ date: 1 });

  return res.status(200).json({
    success: true,
    data: holidays,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    },
  });
});

export const exportHolidays = handleAsync(async (req, res) => {
  const { search } = req.body;
  const filter = {};

  if (search) {
    filter.$or = [{ name: { $regex: search, $options: "i" } }];
  }

  const holidays = await Holiday.find(filter).populate(
    "applicableDepartments",
    "name",
  );

  return res.status(200).json({
    success: true,
    data: holidays,
  });
});

export const getAllHolidaysForDrops = handleAsync(async (req, res) => {
  const holidays = await Holiday.find().populate(
    "applicableDepartments",
    "name",
  );
  return res.status(200).json({
    success: true,
    data: holidays,
  });
});

export const getHoliday = handleAsync(async (req, res, next) => {
  const holiday = await Holiday.findById(req.params.id).populate(
    "applicableDepartments",
    "name",
  );
  if (!holiday) {
    return next(new AppError("No holiday found with that ID", 404));
  }
  res.status(200).json({
    status: "success",
    data: {
      holiday,
    },
  });
});

// Update Holiday
export const updateHoliday = handleAsync(async (req, res, next) => {
  const { isGlobal, holidayData } = req.body;

  // Extract payload if nested in holidayData or direct
  const updateData = holidayData || req.body;

  if (updateData.isGlobal === true) {
    updateData.applicableDepartments = [];
  }

  const holiday = await Holiday.findByIdAndUpdate(req.params.id, updateData, {
    new: true,
    runValidators: true,
  }).populate("applicableDepartments", "name");

  if (!holiday) {
    return next(new AppError("No holiday found with that ID", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      holiday,
    },
  });
});

// Delete Holiday
export const deleteHoliday = handleAsync(async (req, res, next) => {
  const holiday = await Holiday.findByIdAndDelete(req.params.id);
  if (!holiday) {
    return next(new AppError("No holiday found with that ID", 404));
  }
  res.status(204).json({
    status: "success",
    data: null,
  });
});
