import Queries from "../../models/queries/Queries.js";
import Messages from "../../models/queries/Message.js";
import Notifications from "../../models/queries/Notification.js";
import Task from "../../models/Task.js";
import { getIO } from "../../socket.js";
import Conversations from "../../models/queries/Conversation.js";

export const raiseQuery = async (req, res) => {
  const { taskId, message, assignedTo } = req.body;

  // 1. Create Query
  const query = await Queries.create({
    taskId,
    message,
    raisedBy: req.cookies.userId, // ✅ Use JWT user, not cookies
    assignedTo,
    status: "Pending",
  });
  // 2. Get/Create Task Conversation
  let task = await Task.findById(taskId);
  let conversation = await Conversations.findOne({ taskId: task._id });

  if (!conversation) {
    conversation = await Conversations.create({
      taskId: task._id,
      taskType: task.taskType, // ✅ FIXED
      participants: [req.cookies.userId, query.assignedTo],
    });

    console.log("✅ Conversation created:", conversation._id);

    task.conversationId = conversation._id;
    await task.save();
  }

  // 3. Link query to first message (optional)
  query.conversationId = task.conversationId;
  await query.save();

  // 4. Real-time emit
  const io = getIO();
  io.to(assignedTo.toString()).emit("new-query", {
    query,
    task,
    conversationId: task.conversationId,
  });

  // 5. Notification
  await Notifications.create({
    user: assignedTo,
    fromUser: req.cookies.userId,
    type: "QUERY_RAISED",
    title: `New Query on Task ${task.TaskId}`,
    description: message.slice(0, 100) + "...",
    relatedId: query._id,
    taskId,
    conversationId: task.conversationId,
  });

  res.json({ success: true, data: query });
};

export const replyToQuery = async (req, res) => {
  const { queryId, conversationId, text } = req.body;

  // 1. Create reply message
  const message = await Messages.create({
    conversationId,
    sender: req.cookies.userId,
    text,
    queryId, // Link to original query
  });

  await message.populate("sender", "name email");

  // 2. Mark query as "Responded"
  const query = await Queries.findByIdAndUpdate(
    queryId,
    {
      status: "Responded",
      repliedBy: req.cookies.userId,
      repliedAt: new Date(),
    },
    { new: true },
  );

  // 3. Emit to conversation
  const io = getIO();
  io.to(conversationId).emit("query-reply", {
    message,
    query,
  });

  // 4. Notify query raiser (if not self-reply)
  if (query.raisedBy.toString() !== req.cookies.userId.toString()) {
    await Notifications.create({
      user: query.raisedBy,
      fromUser: req.cookies.userId,
      type: "QUERY_REPLIED",
      title: `Query Replied - ${query.message.slice(0, 50)}`,
      description: text.slice(0, 100) + "...",
      relatedId: query._id,
      taskId: query.taskId,
      conversationId,
    });

    io.to(query.raisedBy.toString()).emit("notification", {
      type: "query-replied",
      title: "Query Replied",
      queryId,
    });
  }

  res.json({ success: true, data: { message, query } });
};

export const getTaskQueries = async (req, res) => {
  const { taskId } = req.params;

  const queries = await Queries.find({ taskId })
    .populate("raisedBy assignedTo repliedBy", "name email department")
    .populate("conversationId")
    .sort({ createdAt: -1 });

  res.json({ success: true, data: queries });
};
