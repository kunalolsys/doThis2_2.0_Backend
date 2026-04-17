import Notifications from "../../models/queries/Notification.js";
import { getIO } from "../../socket.js";

export const markNotificationRead = async (req, res) => {
  const { notificationId } = req.params;

  const notification = await Notifications.findOneAndUpdate(
    { 
      _id: notificationId,
      user:  req.cookies.userId 
    },
    { 
      isRead: true,
      readAt: new Date()
    },
    { new: true }
  );

  if (!notification) {
    return res.status(404).json({ 
      success: false, 
      message: "Notification not found or access denied" 
    });
  }

  // Emit read status (optional)
  const io = getIO();
  io.to( req.cookies.userId.toString()).emit("notification-read", {
    notificationId,
    userId:  req.cookies.userId
  });

  res.json({ 
    success: true, 
    message: "Notification marked as read",
    data: notification 
  });
};

export const markAllRead = async (req, res) => {
  const notifications = await Notifications.updateMany(
    {
      user:  req.cookies.userId,
      isRead: false
    },
    {
      isRead: true,
      readAt: new Date()
    }
  );

  const io = getIO();
  io.to( req.cookies.userId.toString()).emit("notifications-all-read", {
    userId:  req.cookies.userId,
    count: notifications.modifiedCount
  });

  res.json({ 
    success: true, 
    message: `${notifications.modifiedCount} notifications marked read`
  });
};

export const getUnreadCount = async (req, res) => {
  const count = await Notifications.countDocuments({
    user:  req.cookies.userId,
    isRead: false
  });

  res.json({ 
    success: true, 
    unreadCount: count 
  });
};

