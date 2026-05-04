import User from "../models/User.js";
import Role from "../models/Role.js";
import Department from "../models/Department.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { handleAsync } from "../utils/handleAsync.js";
import crypto from "crypto";
import { sendVerificationEmail } from "../utils/sendVerificationEmail.js";
import AppError from "../utils/AppError.js";

// Login controller
export const login = handleAsync(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(new AppError("Please provide email and password", 400));
  }
  const emailNormalized = String(email).trim().toLowerCase();
  console.log("Login attempt for:", emailNormalized);

  const user = await User.findOne({ email: emailNormalized })
    .select("+password +isActive")
    .populate("department", "name")
    .populate("role", "name permissions"); // <-- Fetches permissions along with the role name
  if (!user) {
    return next(new AppError("Incorrect email or password", 401));
  }

  // Check if user is active using isActive boolean
  // if (!user.isActive) {
  //     return next(new AppError('Your account is inactive. Please contact administrator.', 403));
  // }

  const compare = await bcrypt.compare(password, user.password);
  if (!compare) {
    return next(new AppError("Incorrect email or password", 401));
  }

  const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

  // console.log("Login User Department: ", user.department.name);
  // console.log("Login User Role ID: ", user.role.name);

  // Convert permissions
  // Safely handle permissions, defaulting to an empty array if they don't exist
  const rolePermissions = user.role?.permissions || [];
  const permissions = rolePermissions.reduce((acc, permission) => {
    acc[permission.toLowerCase().replace(/ /g, "_") + "_view"] = true;
    return acc;
  }, {});

  res
    .status(200)
    .cookie("token", token, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      // secure: process.env.NODE_ENV === 'production',
      // sameSite: 'strict'
    })
    .json({
      success: true,
      message: "Login successful",
      token,
      permissions,
      role: user.role?.name || null,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        isActive: user.isActive, // Include isActive in response
        department: Array.isArray(user.department)
          ? user.department.map((d) => d)
          : user.department || null,
        role: user.role || null,
      },
    });
});

// export const register = handleAsync(async (req, res, next) => {
//     const { name, email, phone, department, role, reportingManager ,assignShift, password,  } = req.body;

//     if (!name || !email || !phone || !password) {
//         return next(new AppError('Please provide all required fields', 400));
//     }

//     const hashedPassword = await bcrypt.hash(password, 12);

//     const newUser = await User.create({
//         name,
//         email,
//         phone,
//         department,
//         role,
//         reportingManager,
//         assignShift,
//         password: hashedPassword,
//     });

//     res.status(201).json({
//         status: 'success',
//         data: {
//             user: newUser
//         },
//         message: 'User registered successfully'
//     });
// });

export const logout = (req, res) => {
  res.cookie("token", "loggedout", {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });
  res.status(200).json({
    success: true,
    message: "User logged out successfully",
  });
};

export const forgotPassword = handleAsync(async (req, res, next) => {
  // 1) Get user based on POSTed email
  const { email } = req.body;
  if (!email) {
    return next(new AppError("Please provide an email address.", 400));
  }
  const user = await User.findOne({ email });

  if (!user) {
    return next(new AppError("Email not exist", 404));
  }

  // 2) Generate the random reset token
  const resetToken = crypto.randomBytes(32).toString("hex");

  // 3) Hash token and set to user document
  user.passwordResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  user.passwordResetExpires = Date.now() + 10 * 60 * 1000; // Token valid for 10 minutes

  await user.save({ validateBeforeSave: false });

  // 4) Send token to user's email
  try {
    await sendVerificationEmail(
      user.email,
      resetToken,
      "reset-password", // A type to distinguish from registration emails
      "Password Reset Request",
    );

    res.status(200).json({
      success: true,
      message: "Password reset link sent to your email.",
    });
  } catch (err) {
    console.error("Error sending reset email:", err);
    // For development, log the reset link in console
    const resetLink = `${process.env.RESET_URL}/reset-password?token=${resetToken}`;
    console.log("Password reset link (for development):", resetLink);

    // Clear the token on error
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    // Still return success to prevent email enumeration, but log the error
    res.status(200).json({
      success: true,
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  }
});

export const resetPassword = handleAsync(async (req, res, next) => {
  const { token, newPassword } = req.body;

  // 1) Get user based on the token
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  // 2) If token has not expired and there is a user, set the new password
  if (!user) {
    return next(new AppError("Token is invalid or has expired.", 400));
  }

  user.password = newPassword;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  res
    .status(200)
    .json({ success: true, message: "Password reset successfully." });
});

export const registerEmail = handleAsync(async (req, res, next) => {
  const { email } = req.body;

  if (!email) {
    return next(new AppError("Please provide an email address.", 400));
  }

  // 1. Check if a user with this email already exists and is active
  const existingUser = await User.findOne({ email });
  if (existingUser && existingUser.isActive) {
    return next(new AppError("A user with this email already exists.", 409)); // 409 Conflict
  }

  // 2. Generate a verification token
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto
    .createHash("sha256")
    .update(verificationToken)
    .digest("hex");

  // 3. Create or update the user with the token and an expiry date
  const user = await User.findOneAndUpdate(
    { email }, // Find user by email
    {
      email,
      emailVerificationToken: hashedToken,
      emailVerificationExpires: Date.now() + 10 * 60 * 1000,
    }, // Set token and 10-min expiry
    { upsert: true, new: true, setDefaultsOnInsert: true }, // Create if not exists, return new doc
  );

  // 4. Send the verification email
  await sendVerificationEmail(user.email, verificationToken);

  res.status(200).json({
    success: true,
    message: "Verification email sent successfully. Please check your inbox.",
  });
});
