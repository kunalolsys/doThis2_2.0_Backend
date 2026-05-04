import Queries from "../../models/queries/Queries.js";
import Messages from "../../models/queries/Message.js";
import Notifications from "../../models/queries/Notification.js";
import Task from "../../models/Task.js";
import { getIO } from "../../socket.js";
import Conversations from "../../models/queries/Conversation.js";
import FmsInstanceTask from "../../models/FmsInstanceTask.js";

export const raiseQuery = async (req, res) => {
  const { taskId, message, assignedTo } = req.body;

  // 1. Create Query
  const query = await Queries.create({
    taskId,
    message,
    raisedBy: req.cookies.userId || req.user._id || null, // ✅ Use JWT user, not cookies
    assignedTo,
    status: "Pending",
  });
  // 2. Get/Create Task Conversation
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
  // let conversation = await Conversations.findOne({ taskId: task._id });

  let conversation = await Conversations.findOne({
    taskId: activeTask._id,
  });
  // if (!conversation) {
  //   conversation = await Conversations.create({
  //     taskId: task._id,
  //     taskType: task.taskType, // ✅ FIXED
  //     participants: [req.cookies.userId, query.assignedTo],
  //   });

  //   console.log("✅ Conversation created:", conversation._id);

  //   task.conversationId = conversation._id;
  //   await task.save();
  // }
  if (!conversation) {
    const userId = req.cookies.userId || req.user._id || null;

    conversation = await Conversations.create({
      taskId: activeTask._id,
      taskType: task ? task.taskType : "FmsInstanceTask", // 🔥 important
      participants: [userId, assignedTo],
    });

    activeTask.conversationId = conversation._id;
    await activeTask.save();
  }
  // 3. Link query to first message (optional)
  query.conversationId = activeTask.conversationId;
  await query.save();

  // 4. Real-time emit
  const io = getIO();
  io.to(assignedTo.toString()).emit("new-query", {
    query,
    task: activeTask,
    conversationId: activeTask.conversationId,
  });
  // 5. Notification
  await Notifications.create({
    user: assignedTo,
    fromUser: req.cookies.userId || req.user._id || null,
    type: "QUERY_RAISED",
    title: `New Query on Task ${activeTask.TaskId || activeTask.taskId}`,
    description: message,
    relatedId: query._id,
    taskId,
    conversationId: activeTask.conversationId,
  });

  res.json({ success: true, data: query });
};

export const replyToQuery = async (req, res) => {
  const { queryId, conversationId, text } = req.body;
  // 1. Create reply message
  const message = await Messages.create({
    conversationId,
    sender: req.cookies.userId || req.user._id || null,
    text,
    queryId, // Link to original query
  });

  await message.populate("sender", "name email");

  // 2. Mark query as "Responded"
  const query = await Queries.findByIdAndUpdate(
    queryId,
    {
      status: "Responded",
      repliedBy: req.cookies.userId || req.user._id || null,
      repliedAt: new Date(),
    },
    { new: true },
  );

  // 3. Emit to conversation
  const io = getIO();
  io.to(conversationId).emit("chat-message", message);
  // io.to(conversationId).emit("query-reply", {
  //   message,
  //   query,
  // });

  // 4. Notify query raiser (if not self-reply)
  const userId = req.cookies.userId || req.user._id || null;
  if (query.raisedBy.toString() !== userId.toString()) {
    await Notifications.create({
      user: query.raisedBy,
      fromUser: userId,
      type: "QUERY_REPLIED",
      title: `Query Replied - ${query.message.slice(0, 50)}`,
      description: text,
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

// Get user's raised queries (across all tasks)
export const getRaisedQueries = async (req, res) => {
  try {
    const userId = req.cookies.userId || req.user._id || null;
    const queries = await Queries.find({ raisedBy: userId })
      .populate("taskId", "TaskId title status dueDate") // Task details
      .populate("assignedTo repliedBy", "name email department")
      .populate("conversationId", "taskId")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: queries,
      count: queries.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get user's assigned queries (to handle)
export const getAssignedQueries = async (req, res) => {
  try {
    const userId = req.cookies.userId || req.user._id || null;

    const queries = await Queries.find({ assignedTo: userId })
      .populate("taskId", "TaskId title status dueDate")
      .populate("raisedBy repliedBy", "name email department")
      .populate("conversationId", "taskId")
      .sort({ createdAt: -1, status: 1 }); // Pending first

    res.json({
      success: true,
      data: queries,
      count: queries.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
