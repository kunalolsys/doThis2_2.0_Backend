import Conversation from "../../models/queries/Conversation.js";
import Messages from "../../models/queries/Message.js";
import Notifications from "../../models/queries/Notification.js";
import Queries from "../../models/queries/Queries.js";
import { getIO } from "../../socket.js";

export const sendMessage = async (req, res) => {
  const { conversationId, text, parentMessage, queryId } = req.body;

  const message = await Messages.create({
    conversationId,
    sender: req.user._id, // ✅ JWT user
    text,
    parentMessage: parentMessage || null,
    queryId: queryId || null, // Link to query
  });

  await message.populate("sender", "name email avatar");

  // Emit to conversation + task room
  const io = getIO();
  io.to(conversationId).emit("new-message", {
    message,
    sender: message.sender
  });

  // Notify participants except sender
  const conversation = await Conversation.findById(conversationId).populate('participants');
  const receivers = conversation.participants.filter(
    p => p._id.toString() !== req.user._id.toString()
  );

  for (const user of receivers) {
    await Notifications.create({
      user: user._id,
      fromUser: req.user._id,
      type: "MESSAGE",
      title: "New Message in Thread",
      description: text.slice(0, 100) + '...',
      relatedId: message._id,
      taskId: conversation.taskId,
      conversationId,
    });

    io.to(user._id.toString()).emit("notification", {
      title: "New Message",
      description: text.slice(0, 50) + '...',
      type: "message"
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
export const raiseQuery = async (req, res) => {
  const { taskId, message, assignedTo } = req.body;

  const query = await Queries.create({
    taskId,
    message,
    raisedBy: req.cookies.userId,
    assignedTo,
  });

  const io = getIO();

  io.to(assignedTo.toString()).emit("new-query", query);

  await Notifications.create({
    user: assignedTo,
    type: "QUERY",
    title: "New Query Raised",
    description: message,
  });

  res.json({ success: true, data: query });
};

export const getNotifications = async (req, res) => {
  const data = await Notifications.find({ user: req.cookies.userId })
    .sort({ createdAt: -1 })
    .limit(20);

  res.json({ success: true, data });
};
