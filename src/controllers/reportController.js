import mongoose from "mongoose";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";

import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsInstance from "../models/FmsInstance.js";
import Task from "../models/Task.js";
import User from "../models/User.js";

const safeObjectId = (id) => {
  if (!id || id === "all") return null;
  return mongoose.Types.ObjectId.isValid(id)
    ? new mongoose.Types.ObjectId(id)
    : null;
};

// 🗓️ Helper for precise Date Boundaries
const calculateDateRange = (period, startDate, endDate) => {
  const now = new Date();
  let start = new Date();
  let end = new Date();

  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === "this_week") {
    const day = now.getDay();
    const diffToMonday = now.getDate() - day + (day === 0 ? -6 : 1);
    start = new Date(now.setDate(diffToMonday));
    start.setHours(0, 0, 0, 0);
    end = new Date();
    end.setHours(23, 59, 59, 999);
  } else if (period === "this_month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (period === "custom" && startDate && endDate) {
    start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
  } else {
    // Default fallback to 30 days
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = new Date();
    end.setHours(23, 59, 59, 999);
  }

  return { start, end };
};

export const getCombinedReport = handleAsync(async (req, res, next) => {
  let {
    period = "this_month",
    startDate,
    endDate,
    departmentId,
    memberIds,
    templateId,
    taskSource = "all", // "all", "fms", "regular"
    timingLogic = "all", // "all", "actual-to-planned", "planned-to-planned"
    taskStatus = "all", // "all", "completed", "pending", "overdue"
    limit = 10,
    page = 1,
  } = req.body;

  // 1. INPUT SANITIZATION & BOUNDARIES
  const departmentObjectId = safeObjectId(departmentId);
  const templateObjectId = safeObjectId(templateId);
  const { start, end } = calculateDateRange(period, startDate, endDate);
  const now = new Date();

  // Normalize Users Array
  let userIdArray = [];
  if (Array.isArray(memberIds) && memberIds.length > 0) {
    userIdArray = memberIds
      .filter((id) => id !== "all")
      .map(safeObjectId)
      .filter(Boolean);
  }

  // 2. MATCH QUERIES
  const fmsMatch = {
    $or: [
      { plannedDueDate: { $gte: start, $lte: end } },
      { plannedStartDate: { $gte: start, $lte: end } },
      { actualCompleteDate: { $gte: start, $lte: end } },
      { createdAt: { $gte: start, $lte: end } },
    ],
  };

  const regularMatch = {
    isDeleted: { $ne: true },
    taskType: { $ne: "RecurringTask" },
    $or: [
      { dueDate: { $ne: null, $gte: start, $lte: end } },
      { endDate: { $ne: null, $gte: start, $lte: end } },
      { startDate: { $ne: null, $gte: start, $lte: end } },
      { createdAt: { $gte: start, $lte: end } },
    ],
  };

  if (userIdArray.length > 0) {
    fmsMatch.assignedTo = { $in: userIdArray };
    regularMatch.assignedTo = { $in: userIdArray };
  }

  if (departmentObjectId) {
    fmsMatch.departmentOfAssignToUser = departmentObjectId;
    regularMatch.departmentOfAssignToUser = departmentObjectId;
  }

  if (timingLogic !== "all") {
    fmsMatch.startTimeSetting = timingLogic;
  }

  if (templateObjectId) {
    const matchingInstances = await FmsInstance.find({
      fmsTemplateId: templateObjectId,
    })
      .select("_id")
      .lean();

    const instanceIds = matchingInstances.map((i) => i._id);
    fmsMatch.fmsInstanceId = instanceIds.length
      ? { $in: instanceIds }
      : { $in: [new mongoose.Types.ObjectId()] };
  }

  // Task Status Filter
  if (taskStatus && taskStatus !== "all") {
    const s = String(taskStatus).toLowerCase();

    if (s === "completed") {
      fmsMatch.status = "Completed";
      regularMatch.status = "Completed";
    } else if (s === "pending") {
      fmsMatch.status = {
        $in: ["Pending", "Ongoing", "InProcess", "Upcoming"],
      };
      regularMatch.status = { $in: ["Pending", "Upcoming", "Ongoing"] };
    } else if (s === "overdue") {
      fmsMatch.$or = [
        { status: "Overdue" },
        { plannedDueDate: { $lt: now }, status: { $ne: "Completed" } },
      ];
      regularMatch.$or = [
        { status: "Overdue" },
        { dueDate: { $lt: now }, status: { $ne: "Completed" } },
      ];
    }
  }

  // 3. EXECUTE DATA FETCHING
  let fmsTasks = [];
  let regularTasks = [];

  if (taskSource === "all" || taskSource === "fms") {
    fmsTasks = await FmsInstanceTask.find(fmsMatch)
      .populate("assignedTo", "name email employeeCode")
      .populate("departmentOfAssignToUser", "name")
      .populate("fmsInstanceId", "instanceName")
      .sort({ plannedDueDate: 1 })
      .lean();
  }

  if (taskSource === "all" || taskSource === "regular") {
    if (timingLogic === "all") {
      regularTasks = await Task.find(regularMatch)
        .populate("assignedTo", "name email employeeCode")
        .populate("departmentOfAssignToUser", "name")
        .sort({ dueDate: 1 })
        .lean();
    }
  }

  // 4. UNIFIED NORMALIZATION
  const normalizedTasks = [
    ...fmsTasks.map((t) => {
      const isCompleted = t.status === "Completed";
      const due = t.plannedDueDate ? new Date(t.plannedDueDate) : null;
      const completedAt = t.actualCompleteDate
        ? new Date(t.actualCompleteDate)
        : null;

      let timeStatus = "Pending";
      if (isCompleted) {
        if (completedAt && due && completedAt <= due) timeStatus = "On Time";
        else timeStatus = "Late";
      } else if (due && due < now) {
        timeStatus = "Overdue";
      }

      return {
        _id: t._id,
        taskId: t.taskId,
        title: t.description || t.taskId,
        taskType: "FMS",
        status: t.status,
        timeStatus,
        startTimeSetting: t.startTimeSetting || "N/A",
        frequency: t.frequency || "One-time",
        startDate: t.plannedStartDate,
        dueDate: t.plannedDueDate,
        completedAt: t.actualCompleteDate,
        assignedTo: t.assignedTo,
        department: t.departmentOfAssignToUser?.name || "—",
        instanceName: t.fmsInstanceId?.instanceName || "—",
        createdAt: t.createdAt,
      };
    }),

    ...regularTasks.map((t) => {
      const isCompleted = t.status === "Completed";
      const due = t.dueDate ? new Date(t.dueDate) : null;
      const completedAt = t.completedAt ? new Date(t.completedAt) : null;

      let timeStatus = "Pending";
      if (isCompleted) {
        if (completedAt && due && completedAt <= due) timeStatus = "On Time";
        else timeStatus = "Late";
      } else if (due && due < now) {
        timeStatus = "Overdue";
      }

      return {
        _id: t._id,
        taskId: t.TaskId || t._id,
        title: t.title || t.description || "Task",
        taskType: "Regular",
        status: t.status,
        timeStatus,
        startTimeSetting: "N/A",
        frequency: t.frequency || "One-time",
        startDate: t.startDate,
        dueDate: t.dueDate,
        completedAt: t.completedAt,
        assignedTo: t.assignedTo,
        department: t.departmentOfAssignToUser?.name || "—",
        instanceName: "N/A",
        createdAt: t.createdAt,
      };
    }),
  ];

  // 5. CALCULATE STATS & PERCENTAGE RATES
  const totalTasks = normalizedTasks.length;
  const completed = normalizedTasks.filter(
    (t) => t.status === "Completed",
  ).length;
  const onTime = normalizedTasks.filter(
    (t) => t.timeStatus === "On Time",
  ).length;
  const late = normalizedTasks.filter((t) => t.timeStatus === "Late").length;
  const overdue = normalizedTasks.filter(
    (t) => t.timeStatus === "Overdue",
  ).length;
  const notDone = totalTasks - completed;

  const actualToPlannedCount = normalizedTasks.filter(
    (t) => t.startTimeSetting === "actual-to-planned",
  ).length;
  const plannedToPlannedCount = normalizedTasks.filter(
    (t) => t.startTimeSetting === "planned-to-planned",
  ).length;

  // Percentage Calculations for Overall System
  const totalForCalc = totalTasks || 1;
  const completedForCalc = completed || 1;

  const completionRate =
    Math.round((completed / totalForCalc) * 100 * 100) / 100;
  const onTimeRate = Math.round((onTime / completedForCalc) * 100 * 100) / 100;
  const lateRate = Math.round((late / completedForCalc) * 100 * 100) / 100;
  const overdueRate = Math.round((overdue / totalForCalc) * 100 * 100) / 100;
  const notDoneRate = Math.round((notDone / totalForCalc) * 100 * 100) / 100;

  const actualToPlannedRate =
    Math.round((actualToPlannedCount / totalForCalc) * 100 * 100) / 100;
  const plannedToPlannedRate =
    Math.round((plannedToPlannedCount / totalForCalc) * 100 * 100) / 100;

  // 6. USER STATS AGGREGATION & PERCENTAGE RATES
  const userStatsMap = new Map();

  normalizedTasks.forEach((t) => {
    const userId = t.assignedTo?._id?.toString() || "unassigned";
    const userName = t.assignedTo?.name || "Unassigned";

    if (!userStatsMap.has(userId)) {
      userStatsMap.set(userId, {
        userId,
        userName,
        employeeCode: t.assignedTo?.employeeCode || "—",
        total: 0,
        completed: 0,
        onTime: 0,
        late: 0,
        overdue: 0,
        notDone: 0,
      });
    }

    const stat = userStatsMap.get(userId);
    stat.total += 1;
    if (t.status === "Completed") stat.completed += 1;
    if (t.timeStatus === "On Time") stat.onTime += 1;
    if (t.timeStatus === "Late") stat.late += 1;
    if (t.timeStatus === "Overdue") stat.overdue += 1;
    if (t.status !== "Completed") stat.notDone += 1;
  });

  const userSummary = Array.from(userStatsMap.values()).map((usr) => {
    const usrTotal = usr.total || 1;
    const usrCompleted = usr.completed || 1;

    return {
      ...usr,
      completionRate: Math.round((usr.completed / usrTotal) * 100 * 100) / 100,
      onTimeRate: Math.round((usr.onTime / usrCompleted) * 100 * 100) / 100,
      lateRate: Math.round((usr.late / usrCompleted) * 100 * 100) / 100,
      overdueRate: Math.round((usr.overdue / usrTotal) * 100 * 100) / 100,
      notDoneRate: Math.round((usr.notDone / usrTotal) * 100 * 100) / 100,
    };
  });

  // Paginate list
  const skip = (Number(page) - 1) * Number(limit);
  const paginatedTasks = normalizedTasks.slice(skip, skip + Number(limit));

  res.status(200).json({
    success: true,
    summary: {
      totalTasks,
      completed,
      onTime,
      late,
      overdue,
      notDone,
      actualToPlannedCount,
      plannedToPlannedCount,
      rates: {
        completionRate,
        onTimeRate,
        lateRate,
        overdueRate,
        notDoneRate,
        actualToPlannedRate,
        plannedToPlannedRate,
      },
    },
    userSummary,
    allTasksForExport: normalizedTasks,
    tasks: paginatedTasks,
    dateRange: {
      start: start.toISOString().split("T")[0],
      end: end.toISOString().split("T")[0],
    },
    pagination: {
      current: Number(page),
      pages: Math.ceil(totalTasks / Number(limit)) || 1,
      total: totalTasks,
      limit: Number(limit),
    },
  });
});
