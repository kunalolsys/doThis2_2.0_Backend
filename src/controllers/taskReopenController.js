import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
import { handleAsync } from "../utils/handleAsync.js";
import { Task } from "../models/Task.js";
import { createLog } from "./logController.js";
import { getIO } from "../socket.js";
import Notifications from "../models/queries/Notification.js";
import Conversations from "../models/queries/Conversation.js";
import Messages from "../models/queries/Message.js";
import sendEmail from "../services/emailService.js";
import { taskReopenedEmail } from "../services/templates/reopenTaskTemplate.js";

// Reopen task: uses isReopen, reopenedBy, reopenedAt
// Also resets status back to Pending (and clears completedAt/taskDoneBy) as confirmed by user.
export const reopenTask = handleAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError("Invalid ID", 400));
  }

  const task = await Task.findById(id)
    .populate("assignedTo", "_id name email")
    .populate("assignedBy", "_id name email");

  if (!task) {
    return next(new AppError("Task not found", 404));
  }

  const oldData = task.toObject();

  const reopenedBy = req.user?._id || req.cookies?.userId || null;

  const reopenReason = req.body?.reason || "Task reopened";
  // ======================================================
  // CREATE CONVERSATION IF NOT EXISTS
  // ======================================================

  let conversation = null;

  if (task.conversationId) {
    conversation = await Conversations.findById(task.conversationId);
  }

  if (!conversation) {
    conversation = await Conversations.create({
      taskId: task._id,
      taskType: task.taskType,
      participants: [
        // reopenedBy,
        task.assignedTo?._id,
        task.assignedBy?._id,
      ].filter(Boolean),
    });

    task.conversationId = conversation._id;
  }
  // ======================================================
  // REOPEN TASK
  // ======================================================

  task.isReopen = true;
  task.reopenedBy = reopenedBy;
  task.reopenedAt = new Date();
  task.reopenedReason = reopenReason;

  // Reset completion fields
  task.status = "Pending";
  task.completeStatus = false;
  task.taskDoneBy = null;
  task.completedAt = null;
  if (Array.isArray(task.checklist) && task.checklist.length > 0) {
    task.checklist = task.checklist.map((item) => ({
      ...item.toObject(),
      isCompleted: false,
    }));
  }
  task.updatedBy = reopenedBy;

  await task.save();

  // ======================================================
  // CREATE SYSTEM MESSAGE IN CHAT
  // ======================================================

  await Messages.create({
    conversationId: conversation._id,
    sender: reopenedBy,
    text: `Task reopened\nReason: ${reopenReason}`,
    systemMessage: true,
  });

  const newData = task.toObject();

  // ======================================================
  // SOCKET NOTIFICATION
  // ======================================================

  const io = getIO();

  // Send realtime notification to assigned user
  if (task.assignedTo?._id) {
    io.to(task.assignedTo._id.toString()).emit("notification", {
      type: "TASK_REOPENED",
      title: "Task Reopened",
      description: `Task "${task.title}" has been reopened`,
      taskId: task._id,
      TaskId: task.TaskId,
    });
  }
  // ======================================================
  // EMAIL NOTIFICATION
  // ======================================================

  const frontendUrl = `${
    process.env.BASE_URL
  }/my-day/mytasks?taskId=${task._id}`;

  if (
    task.assignedTo?.email &&
    task.assignedTo._id.toString() !== reopenedBy?.toString()
  ) {
    await sendEmail({
      to: task.assignedTo.email,
      subject: `🔁 Task Reopened — ${task.TaskId}: ${task.title}`,
      html: taskReopenedEmail({ task, reopenReason, frontendUrl }),
    });
  }
  // ======================================================
  // DATABASE NOTIFICATION
  // ======================================================

  if (
    task.assignedTo?._id &&
    task.assignedTo._id.toString() !== reopenedBy?.toString()
  ) {
    await Notifications.create({
      user: task.assignedTo._id,
      fromUser: reopenedBy,
      type: "TASK_REOPENED",
      title: "Task Reopened",
      description: `Task "${task.title}" has been reopened please check your email.`,
      relatedId: task._id,
      taskId: task._id,
      conversationId: conversation._id,
    });
  }

  // ======================================================
  // LOG
  // ======================================================

  await createLog({
    action: "REOPEN",
    module: "TASK",
    documentId: task._id,
    performedBy: reopenedBy,
    oldData,
    newData,
    message: `Task Reopened | Title: ${task.title} | ID: ${task.TaskId}`,
  });

  // ======================================================
  // RESPONSE
  // ======================================================

  return res.status(200).json({
    success: true,
    message: "Task reopened successfully",
    data: task,
  });
});
