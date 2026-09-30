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

// 🗓️ Helper for precise Date Boundaries (MUTATION SAFE)
const calculateDateRange = (period, startDate, endDate) => {
  const now = new Date();
  let start = new Date();
  let end = new Date();

  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === "this_week") {
    const tempNow = new Date(); // Fix: Avoid mutating global 'now'
    const day = tempNow.getDay();
    const diffToMonday = tempNow.getDate() - day + (day === 0 ? -6 : 1);
    start = new Date(tempNow.setDate(diffToMonday));
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
    taskStatus = "all", // "all", "completed", "pending", "overdue", "upcoming"
    limit = 10,
    page = 1,
  } = req.body;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 10);
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

  // Task Status Filter (MongoDB Layer)
  if (taskStatus && taskStatus !== "all") {
    const s = String(taskStatus).toLowerCase();

    if (s === "completed") {
      fmsMatch.status = "Completed";
      regularMatch.status = "Completed";
    } else if (s === "pending") {
      fmsMatch.status = { $in: ["Pending", "Ongoing", "InProcess"] };
      regularMatch.status = { $in: ["Pending", "Ongoing"] };
    } else if (s === "upcoming") {
      fmsMatch.status = "Upcoming";
      regularMatch.status = "Upcoming";
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

  // 4. UNIFIED NORMALIZATION WITH STRICT TIME STATUS BUCKETS
  const normalizedTasks = [
    ...fmsTasks.map((t) => {
      const isCompleted = t.status === "Completed";
      const isUpcoming = t.status === "Upcoming";
      const due = t.plannedDueDate ? new Date(t.plannedDueDate) : null;
      const completedAt = t.actualCompleteDate
        ? new Date(t.actualCompleteDate)
        : null;

      // 🎯 Strict Mutually Exclusive Categorization
      let executionStatus = "Pending";

      if (isCompleted) {
        if (completedAt && due && completedAt <= due) {
          executionStatus = "On Time";
        } else {
          executionStatus = "Late";
        }
      } else if (isUpcoming) {
        executionStatus = "Upcoming";
      } else if (due && due < now) {
        executionStatus = "Overdue";
      } else {
        executionStatus = "Pending";
      }

      return {
        _id: t._id,
        taskId: t.taskId,
        title: t.description || t.taskId,
        taskType: "FMS",
        status: t.status,
        executionStatus, // Dedicated execution status
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
      const isUpcoming = t.status === "Upcoming";
      const due = t.dueDate ? new Date(t.dueDate) : null;
      const completedAt = t.completedAt ? new Date(t.completedAt) : null;

      let executionStatus = "Pending";

      if (isCompleted) {
        if (completedAt && due && completedAt <= due) {
          executionStatus = "On Time";
        } else {
          executionStatus = "Late";
        }
      } else if (isUpcoming) {
        executionStatus = "Upcoming";
      } else if (due && due < now) {
        executionStatus = "Overdue";
      } else {
        executionStatus = "Pending";
      }

      return {
        _id: t._id,
        taskId: t.TaskId || t._id,
        title: t.title || t.description || "Task",
        taskType: "Regular",
        status: t.status,
        executionStatus,
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
  ].filter((t) => t.dueDate != null); // 🚫 Filter: Missing/null dueDate wale tasks count me nahi aayenge

  // 5. CLEAR MUTUALLY EXCLUSIVE STATS (No Duplication Mismatch)
  const totalTasks = normalizedTasks.length;

  const onTime = normalizedTasks.filter(
    (t) => t.executionStatus === "On Time",
  ).length;
  const late = normalizedTasks.filter(
    (t) => t.executionStatus === "Late",
  ).length;
  const completed = onTime + late; // Completed is exactly OnTime + Late

  const overdue = normalizedTasks.filter(
    (t) => t.executionStatus === "Overdue",
  ).length;
  const pending = normalizedTasks.filter(
    (t) => t.executionStatus === "Pending",
  ).length;
  const upcoming = normalizedTasks.filter(
    (t) => t.executionStatus === "Upcoming",
  ).length;
  const notCompleted = totalTasks - completed; // Exactly Overdue + Pending + Upcoming

  const actualToPlannedCount = normalizedTasks.filter(
    (t) => t.startTimeSetting === "actual-to-planned",
  ).length;
  const plannedToPlannedCount = normalizedTasks.filter(
    (t) => t.startTimeSetting === "planned-to-planned",
  ).length;

  // Percentage Calculations
  const safeDiv = (num, denom) =>
    denom > 0 ? Math.round((num / denom) * 100 * 100) / 100 : 0;

  const rates = {
    completionRate: safeDiv(completed, totalTasks),
    onTimeRate: safeDiv(onTime, completed), // Completed me se kitne On-time hue
    lateRate: safeDiv(late, completed), // Completed me se kitne Late hue
    overdueRate: safeDiv(overdue, totalTasks),
    pendingRate: safeDiv(pending, totalTasks),
    upcomingRate: safeDiv(upcoming, totalTasks),
    notCompletedRate: safeDiv(notCompleted, totalTasks),
    actualToPlannedRate: safeDiv(actualToPlannedCount, totalTasks),
    plannedToPlannedRate: safeDiv(plannedToPlannedCount, totalTasks),
  };

  // 6. USER STATS AGGREGATION
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
        pending: 0,
        upcoming: 0,
        notCompleted: 0,
      });
    }

    const stat = userStatsMap.get(userId);
    stat.total += 1;

    if (t.executionStatus === "On Time") {
      stat.onTime += 1;
      stat.completed += 1;
    } else if (t.executionStatus === "Late") {
      stat.late += 1;
      stat.completed += 1;
    } else if (t.executionStatus === "Overdue") {
      stat.overdue += 1;
      stat.notCompleted += 1;
    } else if (t.executionStatus === "Upcoming") {
      stat.upcoming += 1;
      stat.notCompleted += 1;
    } else {
      stat.pending += 1;
      stat.notCompleted += 1;
    }
  });

  const userSummary = Array.from(userStatsMap.values()).map((usr) => ({
    ...usr,
    completionRate: safeDiv(usr.completed, usr.total),
    onTimeRate: safeDiv(usr.onTime, usr.completed),
    lateRate: safeDiv(usr.late, usr.completed),
    overdueRate: safeDiv(usr.overdue, usr.total),
    pendingRate: safeDiv(usr.pending, usr.total),
    upcomingRate: safeDiv(usr.upcoming, usr.total),
    notCompletedRate: safeDiv(usr.notCompleted, usr.total),
  }));

  // Pagination Logic
  const skip = (pageNum - 1) * limitNum;
  const paginatedTasks = normalizedTasks.slice(skip, skip + limitNum);

  res.status(200).json({
    success: true,
    summary: {
      totalTasks,
      completed,
      onTime,
      late,
      overdue,
      pending,
      upcoming,
      notCompleted,
      actualToPlannedCount,
      plannedToPlannedCount,
      rates,
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
