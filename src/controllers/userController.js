import bcrypt from "bcrypt";
import User from "../models/User.js";
import Role from "../models/Role.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import Department from "../models/Department.js";
import WorkShift from "../models/WorkShift.js";
import sendEmail from "../services/emailService.js";
import fs from "fs";

import {
  greetingTemplate,
  taskAssignedTemplate,
} from "../services/templates.js";
import { createLog } from "./logController.js";
import mongoose from "mongoose";
// Get all users
async function getAllSubordinates(managerId) {
  const subordinates = await User.find({
    reportingManager: managerId,
    isDeleted: { $ne: true },
  }).select("_id");
  const subordinateIds = subordinates.map((user) => user._id);

  let allSubordinates = [...subordinateIds];

  for (const subId of subordinateIds) {
    const deeperSubordinates = await getAllSubordinates(subId);
    allSubordinates = allSubordinates.concat(deeperSubordinates);
  }

  return allSubordinates;
}
export const getAllUsers = handleAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 10,
    active,
    managerId,
    role,
    department,
    assignShift,
    search,
  } = req.body;

  const filter = { isDeleted: { $ne: true } };

  // ✅ Active filter
  if (active === true || active === "true") {
    filter.isActive = true;
  }

  // ✅ Manager + subordinates filter
  if (managerId) {
    const subordinateIds = await getAllSubordinates(managerId);
    subordinateIds.push(managerId);
    filter._id = { $in: subordinateIds };
  }
  // 🔥 ✅ SEARCH FILTER (IMPORTANT)
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { employeeCode: { $regex: search, $options: "i" } },
    ];
  }
  // ✅ Role filter
  if (role) {
    filter.role = role; // pass role _id
  }

  // ✅ Department filter
  if (department) {
    filter.department = {
      $in: Array.isArray(department) ? department : [department],
    };
  }

  // ✅ Assign Shift filter
  if (assignShift) {
    filter.assignShift = assignShift;
  }

  // ✅ Pagination calc
  const skip = (page - 1) * limit;

  // ✅ Total count (for frontend pagination)
  // const total = await User.countDocuments(filter);

  // ✅ Fetch users
  const superRole = await Role.findOne({
    name: "Super",
  }).select("_id");

  if (superRole) {
    filter.role = { $ne: superRole._id };
  }
  const users = await User.find(filter, "-password")
    .populate("department", "name")
    .populate("reportingManager", "name")
    .populate("role", "name")
    .populate("assignShift")
    .sort({ createdAt: -1 })
    .lean();

  // ✅ remove Super users
  const filteredUsers = users.filter((user) => user.role?.name !== "Super");

  // ✅ pagination after filtering
  const total = filteredUsers.length;

  const paginatedUsers = filteredUsers.slice(skip, skip + Number(limit));

  return res.status(200).json({
    success: true,
    data: paginatedUsers,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
    },
  });
});
export const getAllUsersForDrop = handleAsync(async (req, res, next) => {
  const filter = { isDeleted: { $ne: true }, isActive: true };
  // ✅ Fetch users
  const superRole = await Role.findOne({
    name: "Super",
  }).select("_id");

  if (superRole) {
    filter.role = { $ne: superRole._id };
  }
  const users = await User.find(filter, "-password")
    .populate("department", "name")
    .populate("role", "name")
    .populate("assignShift")
    .sort({ createdAt: -1 });
  const totalUser = await User.countDocuments(filter);
  return res.status(200).json({
    success: true,
    data: users,
    totalUser,
  });
});
export const dashboardUserCount = handleAsync(async (req, res, next) => {
  const filter = { isDeleted: { $ne: true }, isActive: true };
  const superRole = await Role.findOne({
    name: "Super",
  }).select("_id");

  if (superRole) {
    filter.role = { $ne: superRole._id };
  }
  const totalUser = await User.countDocuments(filter);
  return res.status(200).json({
    success: true,
    totalUser,
  });
});
export const exportUsers = handleAsync(async (req, res) => {
  const { role, department, assignShift, search } = req.body;

  const filter = { isDeleted: { $ne: true } };

  if (role) filter.role = role;

  if (department && department.length > 0) {
    filter.department = { $in: department };
  }

  if (assignShift) filter.assignShift = assignShift;

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { employeeCode: { $regex: search, $options: "i" } },
    ];
  }

  // 🔥 NO PAGINATION HERE
  const users = await User.find(filter, "-password")
    .populate("department", "name")
    .populate("role", "name")
    .populate("assignShift");

  return res.status(200).json({
    success: true,
    data: users,
  });
});

export const getAllUserForDrops = handleAsync(async (req, res) => {
  const filter = { isDeleted: { $ne: true } };
  // 🔥 NO PAGINATION HERE
  const superRole = await Role.findOne({
    name: "Super",
  }).select("_id");

  if (superRole) {
    filter.role = { $ne: superRole._id };
  }
  const users = await User.find(filter)
    .select("department role assignShift name _id")
    .populate("department", "name")
    .populate("role", "name")
    .populate("assignShift");

  return res.status(200).json({
    success: true,
    data: users,
  });
});
export const getAllFilterUserForDrops = handleAsync(async (req, res) => {
  const userId = req.cookies.userId || req.user._id || null;
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

  let filter = {
    isDeleted: { $ne: true },
  };

  // ✅ Non-admin users only see reporting users
  if (!isSuperUser) {
    // ✅ Member → only himself
    if (isMember) {
      filter._id = loggedInUser._id;
    }

    // ✅ Manager / Sr.Manager → reporting users
    else {
      filter.reportingManager = loggedInUser._id;
    }
  }
  const superRole = await Role.findOne({
    name: "Super",
  }).select("_id");

  if (superRole) {
    filter.role = { $ne: superRole._id };
  }
  const users = await User.find(filter)
    .select("department role assignShift name _id reportingManager")
    .populate("department", "name")
    .populate("role", "name")
    .populate("assignShift");

  return res.status(200).json({
    success: true,
    data: users,
  });
});
export const createUser = handleAsync(async (req, res, next) => {
  const {
    name,
    email,
    phone,
    telegramUserName,
    department,
    role,
    reportingManager,
    assignShift,
    password,
    employeeCode,
    secondaryEmail,
    mainEmailType,
    isEmailNotificationEnabled,
    telegramNotificationsEnabled,
  } = req.body;

  if (!name || !email || !phone || !password) {
    return next(new AppError("Please provide all required fields", 400));
  }
  // Validate unique employeeCode if provided
  if (employeeCode) {
    const existingCode = await User.findOne({
      employeeCode: {
        $regex: `^${String(employeeCode).trim()}$`,
        $options: "i",
      },
    });
    if (existingCode) {
      return next(new AppError("Employee code already exists", 400));
    }
  }

  if (mainEmailType === "secondaryEmail" && !secondaryEmail) {
    return next(
      new AppError("Secondary email required when selected as main", 400),
    );
  }
  // const hashedPassword = await bcrypt.hash(password, 12);

  const newUser = await User.create({
    name,
    email,
    phone,
    telegramUserName,
    telegramNotificationsEnabled,
    employeeCode,
    department:
      Array.isArray(department) && department.length > 0
        ? department
        : undefined,
    role,
    // reportingManager,
    reportingManager:
      reportingManager && mongoose.Types.ObjectId.isValid(reportingManager)
        ? reportingManager
        : undefined,
    assignShift,
    password: password,
    isEmailNotificationEnabled: isEmailNotificationEnabled,
    mainEmailType: mainEmailType || "email",
  });
  await createLog({
    action: "CREATE",
    module: "USER",
    documentId: newUser._id,
    performedBy: req.cookies.userId || req.user._id || null,
    newData: newUser,
    message: "User created",
  });
  res.status(201).json({
    status: "success",
    data: {
      user: newUser,
    },
    message: "User registered successfully",
  });
});
// Update user

const deleteFile = (filePath) => {
  if (!filePath) return;

  const fullPath = `.${filePath}`;

  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
};
export const updateUser = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const {
    name,
    email,
    phone,
    telegramUserName,
    telegramNotificationsEnabled,
    password,
    department,
    role,
    isActive,
    reportingManager,
    assignShift,
    employeeCode,
    secondaryEmail,
    mainEmailType,
    isEmailNotificationEnabled,
  } = req.body;

  const user = await User.findById(id);
  const oldData = user.toObject();
  if (!user) {
    return next(new AppError("User not found", 404));
  }
  if (mainEmailType === "secondaryEmail" && !secondaryEmail) {
    return next(
      new AppError("Secondary email required when selected as main", 400),
    );
  }
  // console.log("email@@@@",typeof email)
  if (name !== undefined) user.name = name;
  if (telegramUserName !== undefined) user.telegramUserName = telegramUserName;
  if (telegramNotificationsEnabled !== undefined) user.telegramNotificationsEnabled = telegramNotificationsEnabled;
  if (email !== undefined) {
    const cleanEmail = email.trim();

    if (!cleanEmail) {
      user.email = undefined; // or reject
    } else {
      user.email = cleanEmail.toLowerCase();
    }
  }
  if (isEmailNotificationEnabled !== undefined) {
    user.isEmailNotificationEnabled = isEmailNotificationEnabled;
  }
  if (secondaryEmail !== undefined) user.secondaryEmail = secondaryEmail;
  if (mainEmailType) {
    user.mainEmailType = mainEmailType || "email";
  }
  if (phone !== undefined) user.phone = phone;
  if (employeeCode !== undefined) {
    const codeTrim = String(employeeCode).trim();
    if (codeTrim) {
      // if changed, ensure uniqueness
      if (
        String(user.employeeCode || "").toLowerCase() !== codeTrim.toLowerCase()
      ) {
        const exists = await User.findOne({
          employeeCode: { $regex: `^${codeTrim}$`, $options: "i" },
          _id: { $ne: user._id },
        });
        if (exists)
          return next(new AppError("Employee code already exists", 400));
      }
      user.employeeCode = codeTrim;
    } else {
      // allow clearing
      user.employeeCode = codeTrim;
    }
  }

  if (password) {
    const hashedPassword = await bcrypt.hash(password, 10);
    user.password = password;
  }

  if (department) user.department = department;
  if (role) {
    const roleExists = await Role.findById(role);
    if (!roleExists) {
      return next(new AppError("Invalid role ID", 400));
    }
    user.role = role;
  }
  if (reportingManager) {
    user.reportingManager = reportingManager;
  }
  if (assignShift) {
    const shiftExists = await WorkShift.findById(assignShift);
    if (!shiftExists) {
      return next(new AppError("Invalid shift ID", 400));
    }
    user.assignShift = assignShift;
  }
  if (isActive !== undefined) user.isActive = isActive;
  if (req.files?.profilePhoto?.[0]) {
    deleteFile(user.profilePhoto);
    user.profilePhoto = `/${req.files.profilePhoto[0].path.replace(/\\/g, "/")}`;
  }
  // if (isEmailNotificationEnabled) {
  //   await sendEmail({
  //     from: user.email,
  //     subject: "Greeting Mail",
  //     html: greetingTemplate(user.name),
  //   });
  // }
  await user.save();
  await createLog({
    action: "UPDATE",
    module: "USER",
    documentId: user._id,
    performedBy: req.cookies.userId || req.user._id || null,
    oldData,
    newData: user,
    message: "User updated",
  });
  // await sendEmail()
  const updatedUser = await User.findById(user._id)
    .populate("department", "name")
    .populate("role", "name")
    .populate("assignShift");

  const userObj = updatedUser.toObject();
  delete userObj.password;

  res.status(200).json({
    status: "success",
    message: "User updated successfully",
    user: userObj,
  });
});

// Delete user
export const deleteUser = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const currentUserId = req.cookies.userId || req.user._id || null;
  const user = await User.findById(id);
  if (!user) {
    return next(new AppError("User not found", 404));
  }
  user.isDeleted = true;
  user.isActive = false;
  user.deletedAt = new Date();
  user.deletedBy = currentUserId;

  await user.save();
  await createLog({
    action: "DELETE",
    module: "USER",
    documentId: user._id,
    performedBy: req.cookies.userId || req.user._id || null,
    oldData: user,
    message: "User deleted",
  });
  res.status(200).json({
    status: "success",
    message: "User deleted successfully",
  });
});

// Get single user by ID
export const getSingleUser = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const user = await User.findById(id)
    .populate("department", "name")
    .populate("role", "name")
    .populate("assignShift")
    .populate("reportingManager", "name");
  if (!user) {
    return next(new AppError("User not found", 404));
  }

  const userObj = user.toObject();
  delete userObj.password; // Remove password from response

  res.status(200).json({
    success: true,
    data: userObj,
  });
});
