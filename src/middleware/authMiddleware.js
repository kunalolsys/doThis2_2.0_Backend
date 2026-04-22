import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    const user = await User.findById(decoded.id);

    if (!user || user.isDeleted) {
      return res.status(403).json({ message: "User not found" });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "User inactive" });
    }

    req.user = user;
    next();
  } catch {
    return res.status(403).json({ message: "Invalid token" });
  }
};
