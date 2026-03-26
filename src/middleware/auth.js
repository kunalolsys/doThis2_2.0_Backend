import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";

export const authenticateJWT = handleAsync(async (req, res, next) => {
    const token = req.cookies.token;

    if (!token) {
        return next(new AppError("Unauthorized Access", 401));
    }

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        return next(new AppError("Invalid token", 401));
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
        return next(new AppError("User not found", 404));
    }

    req.user = {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        telegramUsername: user.telegramUsername,
        role: user.role
    }
    next();
});