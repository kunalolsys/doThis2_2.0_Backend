import Conversation from "../../models/queries/Conversation.js";
import Messages from "../../models/queries/Message.js";
import Notifications from "../../models/queries/Notification.js";
import Queries from "../../models/queries/Queries.js";
import { getIO } from "../../socket.js";

export const sendMessage = async (req, res) => {
  const { conversationId, text, parentMessage, queryId } = req.body;

  const message = await Messages.create({
    conversationId,
    sender: req.cookies.userId, // ✅ JWT user
    text,
    parentMessage: parentMessage || null,
    queryId: queryId || null, // Link to query
  });

  await message.populate("sender", "name email avatar");

  // Emit to conversation + task room
  const io = getIO();
  io.to(conversationId).emit("new-message", {
    message,
    sender: message.sender,
  });

  // Notify participants except sender
  const conversation =
    await Conversation.findById(conversationId).populate("participants");
  const receivers = conversation.participants.filter(
    (p) => p._id.toString() !== req.cookies.userId.toString(),
  );

  for (const user of receivers) {
    await Notifications.create({
      user: user._id,
      fromUser: req.cookies.userId,
      type: "MESSAGE",
      title: "New Message in Thread",
      description: text,
      relatedId: message._id,
      taskId: conversation.taskId,
      conversationId,
    });

    io.to(user._id.toString()).emit("notification", {
      title: "New Message",
      description: text,
      type: "message",
    });
  }

  res.json({ success: true, data: message });
};

export const markAsSeen = async (req, res) => {
  const { messageId } = req.body;

  await Messages.updateOne(
    { _id: messageId },
    {
      $addToSet: {
        seenBy: {
          user: req.cookies.userId,
          seenAt: new Date(),
        },
      },
    },
  );

  const io = getIO();
  io.emit("message-seen", {
    messageId,
    userId: req.cookies.userId,
  });

  res.json({ success: true });
};
// REMOVED: Duplicate raiseQuery → Use /api/queries/raise only

export const getNotifications = async (req, res) => {
  const data = await Notifications.find({ user: req.cookies.userId })
    .populate("fromUser", "name email") // 👈 sender info
    .populate("user", "name email")
    .populate({
      path: "conversationId",
    })
    .sort({ createdAt: -1 })
    .limit(20);

  res.json({ success: true, data });
};

// Get all messages for a conversation (for frontend chat UI)
export const getMessagesByConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const messages = await Messages.find({ conversationId })
      .populate("sender", "name email avatar department")
      .populate("parentMessage", "text createdAt sender")
      .populate("conversationId", "taskId participants")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Messages.countDocuments({ conversationId });

    res.json({
      success: true,
      data: {
        messages,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
