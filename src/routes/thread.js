import express from "express";
import {
  sendMessage,
  markAsSeen,
  getNotifications,
  getMessagesByConversation,
} from "../controllers/queries/thread.js";
import {
  markNotificationRead,
  markAllRead,
  getUnreadCount,
} from "../controllers/queries/notificationController.js";
import { authenticateJWT } from "../middleware/auth.js";

const router = express.Router();

router.post("/message", sendMessage);
router.post("/seen", markAsSeen);
router.get("/notifications", getNotifications);
router.get("/:conversationId/messages", authenticateJWT, getMessagesByConversation);

// Notification read endpoints
router.patch("/notifications/:notificationId/read", markNotificationRead);
router.post("/notifications/read-all", markAllRead);
router.get("/notifications/unread-count", getUnreadCount);

export default router;
