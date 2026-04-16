import express from "express";
import {
  sendMessage,
  markAsSeen,
  getNotifications,
  raiseQuery, // Keep existing
} from "../controllers/queries/thread.js";
import { authenticateJWT } from "../middleware/auth.js";

const router = express.Router();

router.post("/message", sendMessage);
router.post("/seen", markAsSeen);
router.get("/notifications", getNotifications);

export default router;
