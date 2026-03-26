import { Holiday } from '../models/Holiday.js';
import AppError from '../utils/AppError.js';
import {handleAsync} from '../utils/handleAsync.js';

// Create a new holiday
export const createHoliday = handleAsync(async (req, res, next) => {
  const { date, name, description, isRecurring } = req.body;
  const holiday = await Holiday.create({ date, name, description, isRecurring });
  res.status(201).json({
    status: 'success',
    data: {
      holiday,
    },
  });
});

// Get all holidays
export const getAllHolidays = handleAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search } = req.body;
    const filter = {};
  
    if (search) {
      filter.$or = [{ name: { $regex: search, $options: "i" } }];
    }
    const skip = (page - 1) * limit;
  
    // ✅ Total count (for frontend pagination)
    const total = await Holiday.countDocuments(filter);
  
    // ✅ Fetch users
    const holidays = await Holiday.find(filter)
      .skip(skip)
      .limit(Number(limit))
      .sort({ createdAt: -1 });
  
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

  // 🔥 NO PAGINATION HERE
  const holidays = await Holiday.find(filter);

  return res.status(200).json({
    success: true,
    data: holidays,
  });
});
export const getAllHolidaysForDrops = handleAsync(async (req, res) => {
  // 🔥 NO PAGINATION HERE
  const holidays = await Holiday.find();
  return res.status(200).json({
    success: true,
    data: holidays,
  });
});
// Get a single holiday
export const getHoliday = handleAsync(async (req, res, next) => {
  const holiday = await Holiday.findById(req.params.id);
  if (!holiday) {
    return next(new AppError('No holiday found with that ID', 404));
  }
  res.status(200).json({
    status: 'success',
    data: {
      holiday,
    },
  });
});

// Update a holiday
export const updateHoliday = handleAsync(async (req, res, next) => {
  const holiday = await Holiday.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!holiday) {
    return next(new AppError('No holiday found with that ID', 404));
  }
  res.status(200).json({
    status: 'success',
    data: {
      holiday,
    },
  });
});

// Delete a holiday
export const deleteHoliday = handleAsync(async (req, res, next) => {
  const holiday = await Holiday.findByIdAndDelete(req.params.id);
  if (!holiday) {
    return next(new AppError('No holiday found with that ID', 404));
  }
  res.status(204).json({
    status: 'success',
    data: null,
  });
});
