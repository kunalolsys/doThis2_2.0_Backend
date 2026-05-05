import FmsInstanceTask from "../../models/FmsInstanceTask.js";
import Conversation from "../../models/queries/Conversation.js";
import Messages from "../../models/queries/Message.js";
import Notifications from "../../models/queries/Notification.js";
import Queries from "../../models/queries/Queries.js";
import Task from "../../models/Task.js";
import { getIO } from "../../socket.js";

export const sendMessage = async (req, res) => {
  const { conversationId, text, parentMessage, queryId, taskId } = req.body;
  const userId = req.cookies.userId || req.user._id || null;
  let task = await Task.findById(taskId);
  let fmsTask = null;
  let isFms = false;

  if (!task) {
    fmsTask = await FmsInstanceTask.findById(taskId);
    isFms = true;
  }
  const activeTask = task || fmsTask;
  if (!activeTask) {
    return res.status(404).json({ message: "Task not found" });
  }
  let conversation = await Conversation.findOne({
    taskId: activeTask._id,
  });
  if (!conversation) {
    const userId = req.cookies.userId || req.user._id || null;

    conversation = await Conversation.create({
      taskId: activeTask._id,
      taskType: task ? task.taskType : "FmsInstanceTask", // 🔥 important
      participants: [userId, activeTask.assignedTo, activeTask.assignedBy],
    });

    activeTask.conversationId = conversation._id;
    await activeTask.save();
  }
  const currentConversationId = conversationId || activeTask.conversationId;
  const message = await Messages.create({
    conversationId: currentConversationId,
    sender: userId, // ✅ JWT user
    text,
    parentMessage: parentMessage || null,
    queryId: queryId || null, // Link to query
  });

  await message.populate("sender", "name email avatar");

  // Emit to conversation + task room
  const io = getIO();
  io.to(currentConversationId.toString()).emit("chat-message", message);

  // io.to(conversationId).emit("new-message", {
  //   message,
  //   sender: message.sender,
  // });

  // Notify participants except sender
  // const conversation =
  //   await Conversation.findById(conversationId).populate("participants");
  conversation = await Conversation.findByIdAndUpdate(
    currentConversationId,
    {
      $addToSet: { participants: userId }, // ✅ adds only if not exists
    },
    { new: true },
  ).populate("participants");
  const receivers = conversation.participants.filter(
    (p) => p._id.toString() !== userId.toString(),
  );
  for (const user of receivers) {
    await Notifications.create({
      user: user._id,
      fromUser: userId,
      type: "MESSAGE",
      title: "New Message in Thread",
      description: text,
      relatedId: message._id,
      taskId: conversation.taskId,
      conversationId: currentConversationId,
    });
    // ✅ Count unread messages for THIS user
    const unreadCount = await Messages.countDocuments({
      currentConversationId,
      sender: { $ne: user._id }, // not sent by them
      "seenBy.user": { $ne: user._id }, // not seen by them
    });

    io.to(user._id.toString()).emit("notification", {
      title: "New Message",
      description: text,
      type: "message",
    });
    io.to(user._id.toString()).emit("unread-count", {
      conversationId: currentConversationId,
      count: unreadCount,
    });
  }

  res.json({ success: true, data: message });
};

export const markAsSeen = async (req, res) => {
  const userId = req.cookies.userId || req.user._id || null;

  const { messageId } = req.body;

  await Messages.updateOne(
    { _id: messageId },
    {
      $addToSet: {
        seenBy: {
          user: userId,
          seenAt: new Date(),
        },
      },
    },
  );

  const io = getIO();
  io.emit("message-seen", {
    messageId,
    userId: userId,
  });

  res.json({ success: true });
};
// REMOVED: Duplicate raiseQuery → Use /api/queries/raise only

export const getNotifications = async (req, res) => {
  const userId = req.cookies.userId || req.user._id || null;

  const data = await Notifications.find({ user: userId })
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
      .populate({
        path: "parentMessage",
        populate: {
          path: "sender",
          select: "name email avatar department",
        },
      })
      .populate({
        path: "queryId",
        populate: [
          {
            path: "raisedBy",
            select: "name email",
          },
          {
            path: "repliedBy",
            select: "name email",
          },
          {
            path: "assignedTo",
            select: "name email",
          },
        ],
      })
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
