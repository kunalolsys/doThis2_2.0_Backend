import Department from "../models/Department.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import User from "../models/User.js";

// Get All Departments
export const getAllDepartment = handleAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search } = req.body;
  const filter = { isDeleted: false };

  if (search) {
    filter.$or = [{ name: { $regex: search, $options: "i" } }];
  }
  const skip = (page - 1) * limit;

  const total = await Department.countDocuments(filter);

  const departments = await Department.find(filter)
    .skip(skip)
    .limit(Number(limit))
    .sort({ createdAt: -1 });

  return res.status(200).json({
    success: true,
    data: departments,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    },
  });
});

export const exportDepartment = handleAsync(async (req, res) => {
  const { search } = req.body;
  const filter = { isDeleted: false };

  if (search) {
    filter.$or = [{ name: { $regex: search, $options: "i" } }];
  }

  const departments = await Department.find(filter);

  return res.status(200).json({
    success: true,
    data: departments,
  });
});

export const getAllDeptsForDrops = handleAsync(async (req, res) => {
  const userId = req.cookies?.userId || req.user?._id || null;
  const loggedInUser = await User.findById(userId).populate("role", "name");

  if (!loggedInUser) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const roleName = loggedInUser.role?.name?.toLowerCase();
  const isSuperUser = roleName === "admin" || roleName === "owner";
  const isMember = roleName === "member";

  let departments = [];

  if (isSuperUser) {
    departments = await Department.find({ isDeleted: false });
  } else if (isMember) {
    departments = await Department.find({
      _id: { $in: loggedInUser.department || [] },
      isDeleted: false,
    });
  } else {
    const reportingUsers = await User.find({
      reportingManager: loggedInUser._id,
      isDeleted: false,
    }).select("department");

    const deptIds = [
      ...new Set(
        reportingUsers.flatMap((u) =>
          (u.department || []).map((d) => d.toString()),
        ),
      ),
    ];

    departments = await Department.find({
      _id: { $in: deptIds },
      isDeleted: false,
    });
  }

  return res.status(200).json({
    success: true,
    data: departments,
  });
});

export const getAllDeptsForDropsForFMS = handleAsync(async (req, res) => {
  const departments = await Department.find({ isDeleted: false });
  return res.status(200).json({
    success: true,
    data: departments,
  });
});

// Create Department (Handles name & workingWeekDays)
export const createDepartment = handleAsync(async (req, res, next) => {
  const { name, workingWeekDays } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return next(new AppError("Department name is required", 400));
  }

  const existingDepartment = await Department.findOne({
    name: name.trim(),
    isDeleted: false,
  });

  if (existingDepartment) {
    return next(new AppError("Department already exists", 400));
  }

  const newDeptPayload = { name: name.trim() };
  if (workingWeekDays) {
    newDeptPayload.workingWeekDays = workingWeekDays;
  }

  const department = await Department.create(newDeptPayload);

  res.status(201).json({
    status: "success",
    message: "Department created successfully",
    department,
  });
});

// Update Department (Handles name & workingWeekDays)
export const updateDepartment = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, workingWeekDays } = req.body;

  const department = await Department.findById(id);
  if (!department || department.isDeleted) {
    return next(new AppError("Department not found", 404));
  }

  if (name) department.name = name.trim();

  // Set custom working days or reset to null (global default)
  department.workingWeekDays =
    workingWeekDays !== undefined
      ? workingWeekDays
      : department.workingWeekDays;

  await department.save();

  res.status(200).json({
    status: "success",
    message: "Department updated successfully",
    data: department,
  });
});

// Delete Department
export const deleteDepartment = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const currentUserId = req.cookies?.userId || req.user?._id || null;
  const department = await Department.findById(id);

  if (!department) {
    return next(new AppError("Department not found", 404));
  }
  if (department.isDeleted) {
    return next(new AppError("Department already deleted", 400));
  }

  const userCount = await User.countDocuments({
    department: id,
    isDeleted: false,
  });

  if (userCount > 0) {
    return next(
      new AppError(
        `Cannot delete department. ${userCount} user(s) are still linked. Unlink them first.`,
        400,
      ),
    );
  }

  department.isDeleted = true;
  department.deletedBy = currentUserId;

  await department.save();

  res.status(200).json({
    status: "success",
    message: "Department deleted successfully",
  });
});
