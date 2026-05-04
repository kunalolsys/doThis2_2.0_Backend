import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import AppError from "../utils/AppError.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/tokenUtil.js";
import { handleAsync } from "../utils/handleAsync.js";

export const login = handleAsync(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(new AppError("Email and password required", 400));
  }

  const emailNormalized = String(email).trim().toLowerCase();

  // 🔍 Find user (primary + secondary email)
  const user = await User.findOne({
    $or: [{ email: emailNormalized }, { secondaryEmail: emailNormalized }],
    isDeleted: false,
  })
    .select("+password +refreshToken")
    .populate("department", "name")
    .populate("role", "name permissions")
    .populate("reportingManager", "name email")
    .populate("assignShift", "name");

  if (!user) {
    return next(new AppError("Invalid credentials", 401));
  }

  // 🚫 Inactive check
  if (!user.isActive) {
    return next(new AppError("Account is inactive", 403));
  }

  // 🔐 Password check
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return next(new AppError("Invalid credentials", 401));
  }

  // 🔑 Tokens
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  // 💾 Save refresh token
  user.refreshToken = refreshToken;
  await user.save();

  // 🧠 Permissions transform (your logic improved)
  const rolePermissions = user.role?.permissions || [];

  const permissions = rolePermissions.reduce((acc, p) => {
    const key = p
      .replace(/([a-z])([A-Z])/g, "$1_$2") // camelCase → snake_case
      .replace(/\s+/g, "_") // spaces → underscore
      .toLowerCase();

    acc[`${key}_view`] = true;

    return acc;
  }, {});
  // 🧹 Clean user object (VERY IMPORTANT)
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

  // 🍪 Send refresh token securely
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: false, // true in production
    sameSite: "lax",
  });

  res.status(200).json({
    success: true,
    message: "Login successful",

    accessToken,
    permissions,
    role: user.role?.name || null,

    user: safeUser,
  });
});

//**Refresh token */
export const refresh = handleAsync(async (req, res) => {
  const token = req.cookies.refreshToken;

  if (!token) return res.sendStatus(401);

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    const user = await User.findById(decoded.id).select("+refreshToken");

    if (!user || user.refreshToken !== token) {
      return res.sendStatus(403);
    }

    const newAccessToken = generateAccessToken(user);

    res.json({ accessToken: newAccessToken });
  } catch {
    res.sendStatus(403);
  }
});

//**Logout */
export const logout = handleAsync(async (req, res) => {
  const token = req.cookies.refreshToken;

  if (token) {
    const user = await User.findOne({ refreshToken: token });
    if (user) {
      user.refreshToken = null;
      await user.save();
    }
  }

  res.clearCookie("refreshToken");

  res.json({
    success: true,
    message: "Logged out successfully",
  });
});
