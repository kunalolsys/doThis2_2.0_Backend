import TaskExtensionMaster from "../models/TaskExtensionMaster.js";
import TaskExtensionRequest from "../models/TaskExtensionRequest.js";
import Task from "../models/Task.js";
import User from "../models/User.js";

import { sendNotificationAlert } from "../utils/notificationHelper.js";
import moment from "moment";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";

// 1. Master Get/Update (Admin Only)
export const getMasterConfig = handleAsync(async (req, res) => {
  let master = await TaskExtensionMaster.findOne({ isActive: true });
  if (!master) {
    master = await TaskExtensionMaster.create({
      daysBeforeDueDate: 2,
      maxExtensionDays: 3,
    });
  }
  res.status(200).json({ success: true, data: master });
});

export const updateMasterConfig = handleAsync(async (req, res) => {
  const { daysBeforeDueDate, maxExtensionDays } = req.body;
  let master = await TaskExtensionMaster.findOne({ isActive: true });
  if (!master) {
    master = new TaskExtensionMaster();
  }
  master.daysBeforeDueDate = Number(daysBeforeDueDate);
  master.maxExtensionDays = Number(maxExtensionDays);
  master.updatedBy = req.user?._id;
  await master.save();

  res
    .status(200)
    .json({ success: true, message: "Master setting updated", data: master });
});

// 2. User ke eligible tasks lana (Jinki due date master ke set dino ke andar hai)
export const getEligibleTasksForExtension = handleAsync(async (req, res) => {
  const userId = req.user?._id || req.body.userId;
  const master = (await TaskExtensionMaster.findOne({ isActive: true })) || {
    daysBeforeDueDate: 2,
    maxExtensionDays: 3,
  };

  const now = new Date();
  const thresholdDate = moment()
    .add(master.daysBeforeDueDate, "days")
    .endOf("day")
    .toDate();

  // Active delegation tasks jo complete nahi hue hain aur window me fall karte hain
  const tasks = await Task.find({
    assignedTo: userId,
    taskType: "DelegationTask",
    isDeleted: { $ne: true },
    status: { $nin: ["Completed", "Stopped", "Not Done"] },
    dueDate: { $gte: now, $lte: thresholdDate },
  }).lean();

  // Check karein kisi task ki request already PENDING toh nahi hai
  const pendingRequests = await TaskExtensionRequest.find({
    taskId: { $in: tasks.map((t) => t._id) },
    status: "PENDING",
  }).select("taskId requestedExtensionDays");

  const pendingMap = new Map(pendingRequests.map((r) => [String(r.taskId), r]));

  const result = tasks.map((t) => ({
    ...t,
    hasPendingRequest: pendingMap.has(String(t._id)),
    pendingDetails: pendingMap.get(String(t._id)) || null,
    maxAllowedDays: master.maxExtensionDays,
  }));

  res.status(200).json({ success: true, data: result, master });
});

// 3. User Extension Request Submit Karega
export const requestTaskExtension = handleAsync(async (req, res, next) => {
  const { taskId, extensionDays, reason } = req.body;
  const userId = req.user?._id;

  const master = (await TaskExtensionMaster.findOne({ isActive: true })) || {
    maxExtensionDays: 3,
  };
  if (extensionDays > master.maxExtensionDays || extensionDays < 1) {
    return next(
      new AppError(
        `Aap sirf 1 se ${master.maxExtensionDays} din tak ka extension maang sakte hain.`,
        400,
      ),
    );
  }

  const task = await Task.findById(taskId);
  if (!task) return next(new AppError("Task nahi mila.", 404));

  const existingPending = await TaskExtensionRequest.findOne({
    taskId,
    status: "PENDING",
  });
  if (existingPending) {
    return next(
      new AppError("Is task ki extension request already pending hai.", 400),
    );
  }

  const currentUser = await User.findById(userId).populate("reportingManager");

  const newRequest = await TaskExtensionRequest.create({
    taskId: task._id,
    requestedBy: userId,
    reportingManager: currentUser.reportingManager?._id || null,
    currentDueDate: task.dueDate,
    requestedExtensionDays: Number(extensionDays),
    reason: reason || "",
  });

  // 🔔 NOTIFICATION TO MANAGER & ADMIN
  const io = req.app.get("io");
  const admins = await User.find({ isDeleted: false, "role.name": "admin" });

  const notifyUsers = [];
  if (currentUser.reportingManager)
    notifyUsers.push(currentUser.reportingManager);
  admins.forEach((adm) => {
    if (!notifyUsers.some((u) => String(u._id) === String(adm._id)))
      notifyUsers.push(adm);
  });

  for (const manager of notifyUsers) {
    await sendNotificationAlert({
      io,
      user: manager,
      title: "Task Date Extension Request",
      message: `User <b>${currentUser.name}</b> ne Task: <b>${task.title}</b> (${task.TaskId || ""}) ke liye <b>${extensionDays} din</b> extension ki request dali hai.\nReason: ${reason || "N/A"}`,
    });
  }

  res.status(201).json({
    success: true,
    message: "Extension request submitted.",
    data: newRequest,
  });
});

// 4. Admin / Manager: Pending Extension Requests dekhna
export const getPendingExtensionRequests = handleAsync(async (req, res) => {
  const requests = await TaskExtensionRequest.find({ status: "PENDING" })
    .populate("taskId", "TaskId title dueDate description status")
    .populate("requestedBy", "name email employeeCode")
    .populate("reportingManager", "name email")
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, data: requests });
});

// 5. Admin / Manager: Single Click Approval or Rejection
export const reviewExtensionRequest = handleAsync(async (req, res, next) => {
  const { requestId, action } = req.body; // action: 'APPROVE' ya 'REJECT'
  const reviewerId = req.user?._id;

  const extRequest = await TaskExtensionRequest.findById(requestId)
    .populate("taskId")
    .populate("requestedBy");

  if (!extRequest || extRequest.status !== "PENDING") {
    return next(new AppError("Valid pending request nahi mili.", 404));
  }

  const task = extRequest.taskId;
  const user = extRequest.requestedBy;
  const io = req.app.get("io");

  if (action === "APPROVE") {
    // Due date extend karein
    const newDueDate = moment(task.dueDate)
      .add(extRequest.requestedExtensionDays, "days")
      .toDate();
    task.dueDate = newDueDate;
    // Agar task overdue state me tha to reset karein
    if (task.status === "Overdue" && newDueDate > new Date()) {
      task.status = "Pending";
    }
    await task.save();

    extRequest.status = "APPROVED";
    extRequest.reviewedBy = reviewerId;
    extRequest.reviewedAt = new Date();
    await extRequest.save();

    // 🔔 Notify User
    await sendNotificationAlert({
      io,
      user,
      title: "Extension Request Approved! ✅",
      message: `Aapke Task <b>${task.title}</b> ki due date <b>${extRequest.requestedExtensionDays} din</b> badha di gayi hai.\nNayi Due Date: <b>${moment(newDueDate).format("DD MMM YYYY, hh:mm A")}</b>`,
    });

    return res
      .status(200)
      .json({ success: true, message: "Task extended successfully." });
  } else {
    extRequest.status = "REJECTED";
    extRequest.reviewedBy = reviewerId;
    extRequest.reviewedAt = new Date();
    await extRequest.save();

    // 🔔 Notify User
    await sendNotificationAlert({
      io,
      user,
      title: "Extension Request Rejected ❌",
      message: `Aapke Task <b>${task.title}</b> ki date extension request reject kar di gayi hai.`,
    });

    return res
      .status(200)
      .json({ success: true, message: "Request rejected." });
  }
});
