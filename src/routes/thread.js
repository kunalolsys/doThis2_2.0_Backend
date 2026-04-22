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
import { authenticateJWT } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/message", authenticateJWT, sendMessage);
router.post("/seen", authenticateJWT, markAsSeen);
router.get("/notifications", authenticateJWT, getNotifications);
router.get(
  "/:conversationId/messages",
  authenticateJWT,
  getMessagesByConversation,
);

// Notification read endpoints
router.patch(
  "/notifications/:notificationId/read",
  authenticateJWT,
  markNotificationRead,
);
router.post("/notifications/read-all", authenticateJWT, markAllRead);
router.get("/notifications/unread-count", authenticateJWT, getUnreadCount);

export default router;
