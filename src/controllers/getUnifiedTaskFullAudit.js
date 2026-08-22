import mongoose from "mongoose";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";

import Task from "../models/Task.js"; // Normal / Delegation / Recurring tasks
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsInstance from "../models/FmsInstance.js";

const safeObjectId = (id) => {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id)
    ? new mongoose.Types.ObjectId(id)
    : null;
};

export const getUnifiedTaskFullAudit = handleAsync(async (req, res, next) => {
  const {
    search, // Task ID, Title, or Description
    taskCategory = "all", // 'all', 'fms', 'delegation'
    status, // 'Completed', 'Overdue', 'Pending', 'In Progress', 'Upcoming'
    assignedTo, // Doer ID
    assignedBy, // Delegator ID
    departmentId, // Department ID
    templateId, // FMS Template ID
    isDependent, // 'yes', 'no'
    startDate, // Filter start range
    endDate, // Filter end range
    sortBy = "dueDate", // 'dueDate', 'createdAt', 'status'
    sortOrder = "asc",
    page = 1,
    limit = 10,
  } = req.body;

  const now = new Date();

  // =========================================================================
  // 1. BUILD QUERY FOR NORMAL TASKS (Delegation & Recurring)
  // =========================================================================
  const normalMatch = { isDeleted: { $ne: true } };

  if (search && search.trim()) {
    const regex = new RegExp(search.trim(), "i");
    normalMatch.$or = [
      { TaskId: regex },
      { title: regex },
      { description: regex },
    ];
  }

  if (assignedTo && safeObjectId(assignedTo))
    normalMatch.assignedTo = safeObjectId(assignedTo);
  if (assignedBy && safeObjectId(assignedBy))
    normalMatch.assignedBy = safeObjectId(assignedBy);
  if (departmentId && safeObjectId(departmentId))
    normalMatch.departmentOfAssignToUser = safeObjectId(departmentId);

  if (isDependent === "yes" || isDependent === "true")
    normalMatch.isDependent = true;
  if (isDependent === "no" || isDependent === "false")
    normalMatch.isDependent = false;

  if (status && status !== "all") {
    if (status === "Overdue") {
      normalMatch.$or = [
        { status: "Overdue" },
        {
          dueDate: { $ne: null, $lt: now },
          status: { $nin: ["Completed", "Cancelled"] },
        },
      ];
    } else {
      normalMatch.status = status;
    }
  }

  if (startDate && endDate) {
    const sDate = new Date(startDate);
    const eDate = new Date(endDate);
    eDate.setHours(23, 59, 59, 999);

    const normalDateCond = [
      { dueDate: { $gte: sDate, $lte: eDate } },
      { startDate: { $gte: sDate, $lte: eDate } },
      { createdAt: { $gte: sDate, $lte: eDate } },
    ];
    if (normalMatch.$or) {
      normalMatch.$and = [{ $or: normalMatch.$or }, { $or: normalDateCond }];
      delete normalMatch.$or;
    } else {
      normalMatch.$or = normalDateCond;
    }
  }

  // =========================================================================
  // 2. BUILD QUERY FOR FMS INSTANCE TASKS
  // =========================================================================
  const fmsMatch = {};

  if (search && search.trim()) {
    const regex = new RegExp(search.trim(), "i");
    fmsMatch.$or = [{ taskId: regex }, { description: regex }];
  }

  if (assignedTo && safeObjectId(assignedTo))
    fmsMatch.assignedTo = safeObjectId(assignedTo);
  if (assignedBy && safeObjectId(assignedBy))
    fmsMatch.assignedBy = safeObjectId(assignedBy);
  if (departmentId && safeObjectId(departmentId))
    fmsMatch.departmentOfAssignToUser = safeObjectId(departmentId);

  if (isDependent === "yes" || isDependent === "true")
    fmsMatch.isDependent = true;
  if (isDependent === "no" || isDependent === "false")
    fmsMatch.isDependent = false;

  if (status && status !== "all") {
    if (status === "Overdue") {
      fmsMatch.$or = [
        { status: "Overdue" },
        {
          plannedDueDate: { $ne: null, $lt: now },
          status: { $nin: ["Completed", "Stopped"] },
        },
      ];
    } else {
      fmsMatch.status = status;
    }
  }

  if (startDate && endDate) {
    const sDate = new Date(startDate);
    const eDate = new Date(endDate);
    eDate.setHours(23, 59, 59, 999);

    const fmsDateCond = [
      { plannedDueDate: { $gte: sDate, $lte: eDate } },
      { plannedStartDate: { $gte: sDate, $lte: eDate } },
      { createdAt: { $gte: sDate, $lte: eDate } },
    ];
    if (fmsMatch.$or) {
      fmsMatch.$and = [{ $or: fmsMatch.$or }, { $or: fmsDateCond }];
      delete fmsMatch.$or;
    } else {
      fmsMatch.$or = fmsDateCond;
    }
  }

  if (templateId && safeObjectId(templateId)) {
    const matchingInstances = await FmsInstance.find({
      fmsTemplateId: safeObjectId(templateId),
    })
      .select("_id")
      .lean();
    const instanceIds = matchingInstances.map((i) => i._id);
    fmsMatch.fmsInstanceId = {
      $in: instanceIds.length ? instanceIds : [new mongoose.Types.ObjectId()],
    };
  }

  // =========================================================================
  // 3. EXECUTE QUERIES PARALLEL BASED ON CATEGORY FILTER
  // =========================================================================
  let fetchNormal = taskCategory === "all" || taskCategory === "delegation";
  let fetchFms =
    (taskCategory === "all" || taskCategory === "fms") && !templateId; // If templateId filtered, only FMS

  if (templateId && templateId !== "all") {
    fetchNormal = false;
    fetchFms = true;
  }

  const [normalTasksRaw, fmsTasksRaw] = await Promise.all([
    fetchNormal
      ? Task.find(normalMatch)
          .populate("assignedTo", "name email")
          .populate("assignedBy", "name email")
          .populate("departmentOfAssignToUser", "name")
          .lean()
      : [],
    fetchFms
      ? FmsInstanceTask.find(fmsMatch)
          .populate("fmsInstanceId", "instanceName status fmsTemplateId")
          .populate("assignedTo", "name email")
          .populate("assignedBy", "name email")
          .populate("departmentOfAssignToUser", "name")
          .lean()
      : [],
  ]);

  // =========================================================================
  // 4. NORMALIZE SCHEMAS INTO A UNIFIED TASK STRUCTURE
  // =========================================================================
  const normalizedNormalTasks = normalTasksRaw.map((t) => ({
    _id: t._id,
    taskCategory: "DelegationTask",
    taskId: t.TaskId || String(t._id),
    title: t.title || t.description,
    description: t.description,
    assignedTo: t.assignedTo,
    assignedBy: t.assignedBy,
    departmentOfAssignToUser: t.departmentOfAssignToUser,
    frequency: t.frequency || "One-Time",
    startDate: t.startDate || t.plannedStartDate,
    dueDate: t.dueDate || t.plannedDueDate,
    status: t.status,
    completedAt: t.completedAt,
    isDependent: Boolean(t.isDependent),
    waitingForParent: Boolean(t.waitingForParent),
    checklist: t.checklist || [],
    createdAt: t.createdAt,
    rawTask: t,
  }));

  const normalizedFmsTasks = fmsTasksRaw.map((t) => ({
    _id: t._id,
    taskCategory: "FmsInstanceTask",
    taskId: t.taskId,
    title: t.description || "FMS Step Task",
    description: t.description,
    assignedTo: t.assignedTo,
    assignedBy: t.assignedBy,
    departmentOfAssignToUser: t.departmentOfAssignToUser,
    frequency: t.frequency || "Workflow Step",
    startDate: t.plannedStartDate,
    dueDate: t.plannedDueDate,
    status: t.status,
    completedAt: t.actualCompleteDate,
    isDependent: Boolean(t.isDependent),
    waitingForParent: Boolean(t.waitingForParent),
    decisionStep: Boolean(t.decisionStep),
    instanceName: t.fmsInstanceId?.instanceName || "—",
    createdAt: t.createdAt,
    rawTask: t,
  }));

  // Combine datasets
  let combinedTasks = [...normalizedNormalTasks, ...normalizedFmsTasks];

  // Global Sorting
  combinedTasks.sort((a, b) => {
    let valA = a[sortBy] ? new Date(a[sortBy]).getTime() : 0;
    let valB = b[sortBy] ? new Date(b[sortBy]).getTime() : 0;
    return sortOrder === "desc" ? valB - valA : valA - valB;
  });

  // Calculate Metrics Summary
  const summary = {
    total: combinedTasks.length,
    completed: combinedTasks.filter((t) => t.status === "Completed").length,
    overdue: combinedTasks.filter(
      (t) =>
        t.status === "Overdue" ||
        (t.dueDate && new Date(t.dueDate) < now && t.status !== "Completed"),
    ).length,
    pending: combinedTasks.filter((t) =>
      ["Pending", "In Progress", "Ongoing", "Upcoming"].includes(t.status),
    ).length,
  };

  // Pagination Slice
  const skip = (Number(page) - 1) * Number(limit);
  const paginatedTasks = combinedTasks.slice(skip, skip + Number(limit));

  res.status(200).json({
    success: true,
    total: combinedTasks.length,
    summary,
    pagination: {
      current: Number(page),
      limit: Number(limit),
      pages: Math.ceil(combinedTasks.length / Number(limit)) || 1,
    },
    tasks: paginatedTasks,
  });
});
