import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import AppError from "../utils/AppError.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/tokenUtil.js";
import { handleAsync } from "../utils/handleAsync.js";

// 1. LOGIN CONTROLLER
export const login = handleAsync(async (req, res, next) => {
  const { loginId, password } = req.body;

  if (!loginId || !password) {
    return next(new AppError("Email/Mobile and password are required", 400));
  }

  const loginValue = String(loginId).trim().toLowerCase();

  // Find user by Email or Phone Number
  const user = await User.findOne({
    $or: [
      { email: loginValue },
      { secondaryEmail: loginValue },
      { phone: loginId },
    ],
    isDeleted: false,
  })
    .select("+password +refreshToken")
    .populate("department", "name")
    .populate("role", "name displayName permissions")
    .populate("reportingManager", "name email")
    .populate("assignShift", "name");

  if (!user) {
    return next(new AppError("Invalid credentials", 401));
  }

  // Account Status Check
  if (!user.isActive) {
    return next(
      new AppError("Account is inactive. Please contact admin.", 403)
    );
  }

  // Password Comparison
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return next(new AppError("Invalid credentials", 401));
  }

  // Token Generation
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  // Save Refresh Token to Database
  user.refreshToken = refreshToken;
  await user.save();

  // Granular Submodule CRUD Permission Map Transformation
  const rolePermissions = user.role?.permissions || [];
  const permissionsMap = {};

  rolePermissions.forEach((p) => {
    if (p && p.submoduleKey && p.actions) {
      const subKey = p.submoduleKey.trim().toLowerCase();
      const actions = p.actions || {};

      permissionsMap[`${subKey}_create`] = !!actions.create;
      permissionsMap[`${subKey}_view`] = !!actions.read;
      permissionsMap[`${subKey}_read`] = !!actions.read;
      permissionsMap[`${subKey}_update`] = !!actions.update;
      permissionsMap[`${subKey}_edit`] = !!actions.update;
      permissionsMap[`${subKey}_delete`] = !!actions.delete;
    }
  });

  // Safe User Payload Construction
  const safeUser = {
    _id: user._id,
    srNo: user.srNo,
    employeeCode: user.employeeCode,
    companyCode: user.companyCode,

    name: user.name,
    email: user.email,
    secondaryEmail: user.secondaryEmail,
    phone: user.phone,

    isActive: user.isActive,

    department: user.department || [],
    role: user.role || null,
    reportingManager: user.reportingManager || null,
    assignShift: user.assignShift || null,

    createdAt: user.createdAt,
  };

  const isProduction = process.env.NODE_ENV === "production";

  // HTTP-Only Cookie Configuration
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  // Also set permissions cookie for immediate client sync
  // res.cookie("permissions", JSON.stringify(permissionsMap), {
  //   httpOnly: false,
  //   secure: isProduction,
  //   sameSite: isProduction ? "strict" : "lax",
  // });

  // Client Role Response string
  const roleDisplayName = user.role?.displayName || user.role?.name || null;

  return res.status(200).json({
    success: true,
    message: "Login successful",
    accessToken,
    permissions: permissionsMap,
    role: roleDisplayName,
    user: safeUser,
  });
});

// 2. REFRESH TOKEN CONTROLLER
export const refresh = handleAsync(async (req, res, next) => {
  const token = req.cookies?.refreshToken;

  if (!token) {
    return next(new AppError("Refresh token missing", 401));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    const user = await User.findById(decoded.id)
      .select("+refreshToken")
      .populate("role", "name permissions");

    if (!user || user.refreshToken !== token || !user.isActive) {
      return next(new AppError("Invalid or expired refresh token", 403));
    }

    const newAccessToken = generateAccessToken(user);

    return res.status(200).json({
      success: true,
      accessToken: newAccessToken,
    });
  } catch (error) {
    return next(new AppError("Invalid refresh token", 403));
  }
});

// 3. LOGOUT CONTROLLER
export const logout = handleAsync(async (req, res, next) => {
  const token = req.cookies?.refreshToken;

  if (token) {
    const user = await User.findOne({ refreshToken: token });
    if (user) {
      user.refreshToken = null;
      await user.save();
    }
  }

  const isProduction = process.env.NODE_ENV === "production";

  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
  });

  res.clearCookie("permissions", {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
  });

  return res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});