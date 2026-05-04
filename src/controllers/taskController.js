import { Task, DelegationTask, RecurringTask } from "../models/Task.js";
import { isSameDay, isAfter, startOfDay, endOfDay, parseISO } from "date-fns";
import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
import { handleAsync } from "../utils/handleAsync.js";
import path from "path";
import fs from "fs";
import { Holiday } from "../models/Holiday.js";
// The user needs to install this dependency: npm install json2csv
import { Parser } from "json2csv";
// The user needs to install this dependency: npm install csv-parser
import csv from "csv-parser";
import { Readable } from "stream";
import User from "../models/User.js";
import Department from "../models/Department.js";
import * as XLSX from "xlsx";
import Counter from "../models/Counter.js";
import DeleteTaskHistory from "../models/DeleteTaskHistory.js";
import {
  calculateActivationDate,
  nextWorkingShiftDate,
  isWorkingDay,
  addWorkingDays,
  addWorkingDaysHoliday,
} from "../utils/dateCalculator.js";
import { createLog } from "./logController.js";
import ScheduleHolidayTask from "../models/ScheduleHolidayTask.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import Conversation from "../models/queries/Conversation.js";
import Notifications from "../models/queries/Notification.js";
import { getIO } from "../socket.js";
import * as threadController from "./queries/thread.js";
import Messages from "../models/queries/Message.js";

// Helper: Parse Date to IST safely handling strings
function parseDateIST(dateStr) {
  if (
    !dateStr ||
    dateStr === "null" ||
    dateStr === "undefined" ||
    dateStr === ""
  ) {
    return null;
  }

  if (typeof dateStr === "string") {
    // Attempt to parse DD-MM-YYYY
    const ddMMyyyyMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (ddMMyyyyMatch) {
      const [_, day, month, year] = ddMMyyyyMatch;
      const utcDate = new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day)),
      );
      return new Date(utcDate.getTime() + 5.5 * 60 * 60 * 1000);
    }

    // Attempt to parse YYYY-MM-DD
    const yyyyMMddMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (yyyyMMddMatch) {
      const [_, year, month, day] = yyyyMMddMatch;
      const utcDate = new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day)),
      );
      return new Date(utcDate.getTime() + 5.5 * 60 * 60 * 1000);
    }
  }

  // Fallback to native Date parsing, might still fail for some ambiguous formats
  const nativeParsedDate = new Date(dateStr);
  if (!isNaN(nativeParsedDate.getTime())) {
    return new Date(nativeParsedDate.getTime() + 5.5 * 60 * 60 * 1000); // Add IST offset
  }

  return null; // Return null if unable to parse
}

// Helper: Clean "null"/"undefined" strings from FormData
const cleanField = (val) => {
  if (
    val === "null" ||
    val === "undefined" ||
    val === "" ||
    val === null ||
    val === undefined
  ) {
    return null;
  }
  return val;
};
const normalizeDate = (dateVal) => {
  if (!dateVal) return null;

  const d = new Date(dateVal);
  d.setHours(0, 0, 0, 0);
  return d;
};

const calculateStatus = (task) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = normalizeDate(task.startDate);
  const due = normalizeDate(task.dueDate);

  // ✅ 1. Completed (always top priority)
  if (task.completeStatus === true) {
    return "Completed";
  }

  // 🔵 2. Upcoming (task not started yet)
  if (start && start.getTime() > today.getTime()) {
    return "Upcoming";
  }

  // 🔴 3. Overdue (deadline already passed)
  if (due && due.getTime() < today.getTime()) {
    return "Overdue";
  }

  // ⚠️ 4. Delayed (deadline is today)
  if (due && due.getTime() === today.getTime()) {
    return "Delayed";
  }

  // 🟢 5. Pending (active & within time)
  return "Pending";
};
const isTaskValidForToday = (task, today) => {
  if (task.taskType !== "RecurringTask") return true;

  const dayName = today
    .toLocaleDateString("en-US", { weekday: "long" })
    .toLowerCase();

  const date = today.getDate();
  const month = today.getMonth() + 1;

  const start = new Date(task.startDate);

  switch (task.frequency) {
    case "Daily":
      return true;

    case "Weekly":
      return task.weekDays?.includes(dayName);

    case "Monthly":
      return start.getDate() === date;

    // case "Quarterly":
    //   return start.getDate() === date && [1, 4, 7, 10].includes(month);
    case "Quarterly": {
      const startMonth = start.getMonth() + 1;

      const monthDiff =
        (today.getFullYear() - start.getFullYear()) * 12 + (month - startMonth);

      return monthDiff >= 0 && monthDiff % 3 === 0 && start.getDate() === date;
    }
    // case "Half Yearly":
    //   return start.getDate() === date && [1, 7].includes(month);

    case "Half Yearly": {
      const startMonth = start.getMonth() + 1;

      const monthDiff =
        (today.getFullYear() - start.getFullYear()) * 12 + (month - startMonth);

      return monthDiff >= 0 && monthDiff % 6 === 0 && start.getDate() === date;
    }
    case "Yearly":
      return start.getDate() === date && start.getMonth() + 1 === month;

    default:
      return false;
  }
};

export const createTask = handleAsync(async (req, res, next) => {
  const {
    assignedTo,
    title,
    description,
    departmentOfAssignToUser,
    startDate,
    dueDate,
    taskEndDays,
    checklist,
    frequency,
    weekDays,
    isDependent,
    parentTask,
    startTimeSetting,
    isDependentFrequency,
    xValue,
    isRecurrent,
    recurrenceFrequency,
    recurrenceEndDate,
  } = req.body;

  // 1. Basic Validation
  if (!assignedTo || !title || !description?.trim()) {
    return next(
      new AppError("Required fields: assignedTo, title, description", 400),
    );
  }

  // --- PARSE ASSIGNEES ---
  let assigneeIds = [];
  try {
    if (
      typeof assignedTo === "string" &&
      (assignedTo.startsWith("[") || assignedTo.includes(","))
    ) {
      const parsed = JSON.parse(assignedTo);
      assigneeIds = Array.isArray(parsed) ? parsed : [assignedTo];
    } else {
      assigneeIds = [assignedTo];
    }
  } catch (e) {
    assigneeIds = [assignedTo];
  }

  const validAssigneeIds = assigneeIds.filter((id) =>
    mongoose.Types.ObjectId.isValid(id),
  );
  if (validAssigneeIds.length === 0) {
    return next(new AppError("Invalid User ID(s) provided", 400));
  }

  // 2. Parse inputs
  const isRec = isRecurrent === "true" || isRecurrent === true;
  const isDep = isDependent === "true" || isDependent === true;
  const isActualToPlanned = isDep && startTimeSetting === "actual-to-planned";

  let parsedChecklist = [];
  if (checklist) {
    try {
      parsedChecklist =
        typeof checklist === "string"
          ? JSON.parse(checklist)
          : Array.isArray(checklist)
            ? checklist
            : [];
    } catch (error) {
      parsedChecklist = [];
    }
  }

  let parsedTaskEndDays = null;
  if (
    taskEndDays !== undefined &&
    taskEndDays !== null &&
    String(taskEndDays).trim() !== ""
  ) {
    const tmp = Number(taskEndDays);
    parsedTaskEndDays = Number.isFinite(tmp) ? tmp : null;
  }

  const dependencyData = {
    taskDependent: cleanField(parentTask),
    startTimeSetting: cleanField(startTimeSetting),
    isDependentFrequency: cleanField(isDependentFrequency),
    xValue:
      xValue && xValue !== "null" && xValue !== "" ? Number(xValue) : null,
  };
  const userId = req.cookies.userId || req.user._id || null;
  const parsedStartDate = cleanField(startDate)
    ? parseDateIST(startDate)
    : isActualToPlanned
      ? null
      : new Date();

  const createdTasks = [];

  // 🔥 3. LOOP PER ASSIGNEE - WORKSHIFT AWARE
  for (const assigneeId of validAssigneeIds) {
    // 🔥 GET USER WITH WORKSHIFT
    const assignedUser =
      await User.findById(assigneeId).populate("assignShift");
    if (!assignedUser) {
      return next(new AppError(`User with ID ${assigneeId} not found`, 404));
    }

    const workShift = assignedUser.assignShift;
    if (!workShift) {
      return next(
        new AppError(`No workshift assigned to user ${assignedUser.name}`, 400),
      );
    }

    // Department logic (unchanged)
    let deptId = null;
    if (departmentOfAssignToUser) {
      deptId = departmentOfAssignToUser;
    } else if (assignedUser.department) {
      if (
        Array.isArray(assignedUser.department) &&
        assignedUser.department.length > 0
      ) {
        deptId = assignedUser.department[0]._id || assignedUser.department[0];
      } else if (typeof assignedUser.department === "object") {
        deptId = assignedUser.department._id || assignedUser.department;
      } else {
        deptId = assignedUser.department;
      }
    }

    // 🔥 COMPUTE EFFECTIVE DATES (WORKSHIFT AWARE)
    let effectiveStartDate = parsedStartDate
      ? await nextWorkingShiftDate(parsedStartDate, workShift._id)
      : await nextWorkingShiftDate(new Date(), workShift._id);

    let effectiveDueDate = null;
    if (parsedTaskEndDays !== null && parsedTaskEndDays > 0) {
      effectiveDueDate = await addWorkingDaysHoliday(
        effectiveStartDate,
        parsedTaskEndDays,
        workShift._id,
      );
    } else if (cleanField(dueDate)) {
      effectiveDueDate = await nextWorkingShiftDate(
        parseDateIST(dueDate),
        workShift._id,
      );
    }

    const commonFields = {
      title: title.trim(),
      description: description.trim(),
      assignedTo: assigneeId,
      assignedBy: userId,
      createdBy: userId,
      updatedBy: userId,
      isDependent: isDep,
      dependencyConfig: dependencyData,
      taskEndDays: parsedTaskEndDays,
      // ✅ FIX: ACTUAL-TO-PLANNED
      startDate: isActualToPlanned ? null : effectiveStartDate,
      dueDate: isActualToPlanned ? null : effectiveDueDate,

      // ✅ NEW FLAG
      waitingForParent: isActualToPlanned,
      // startDate: effectiveStartDate,
      // dueDate: effectiveDueDate,
      departmentOfAssignToUser: deptId,
      checklist: parsedChecklist,
    };

    // 🔥 DEPENDENT PLANNED-TO-PLANNED (WorkShift Aware)
    if (
      isDep &&
      dependencyData.taskDependent &&
      dependencyData.startTimeSetting === "planned-to-planned"
    ) {
      try {
        let parent = null;
        if (mongoose.Types.ObjectId.isValid(dependencyData.taskDependent)) {
          parent = await Task.findById(dependencyData.taskDependent).lean();
        }
        if (!parent) {
          parent = await Task.findOne({
            TaskId: String(dependencyData.taskDependent),
          }).lean();
        }

        if (parent) {
          const parentEnd =
            parent.dueDate || parent.endDate || parent.startDate;
          if (!parentEnd) return;

          const x = Number(dependencyData.xValue) || 0;
          const freqStr = (
            dependencyData.isDependentFrequency || ""
          ).toLowerCase();

          // 🔹 Step 1: Use only parent DATE
          let baseDate = new Date(parentEnd);
          baseDate.setHours(0, 0, 0, 0); // zero time

          // 🔹 Step 2: Determine start date based on frequency type
          let childStart;
          if (freqStr.includes("hour")) {
            // Hour-based: shift start + X hours
            const shiftStart = await nextWorkingShiftDate(
              baseDate,
              workShift._id,
            );
            childStart = new Date(shiftStart);
            childStart.setHours(childStart.getHours() + x);
          } else {
            // Day-based: add X working days → shift start of that day
            childStart = await addWorkingDaysHoliday(
              baseDate,
              x,
              workShift._id,
            );
          }

          commonFields.startDate = childStart;

          // 🔹 Step 3: Compute dueDate if taskEndDays exist
          if (parsedTaskEndDays) {
            commonFields.dueDate = await addWorkingDaysHoliday(
              commonFields.startDate,
              parsedTaskEndDays,
              workShift._id,
            );
          }
        } else {
          console.log("❌ No parent task found");
        }
      } catch (err) {
        console.error("Error computing dependent dates:", err);
      }
    }
    let newTask;

    // --- TASK TYPE LOGIC ---
    if (isRec) {
      // 🔥 RECURRING: Validate startDate compatibility
      let modelFrequency = frequency || recurrenceFrequency;
      const freqMap = {
        daily: "Daily",
        weekly: "Weekly",
        fortnightly: "Fortnightly",
        monthly: "Monthly",
        quarterly: "Quarterly",
        "half-yearly": "Half Yearly",
        yearly: "Yearly",
      };
      modelFrequency = freqMap[modelFrequency?.toLowerCase()] || modelFrequency;

      if (!modelFrequency)
        return next(
          new AppError("Frequency is required for recurring tasks", 400),
        );

      // 🔥 Validate recurring startDate is working day AND in weekDays (if specified)
      if (!isWorkingDay(effectiveStartDate, workShift)) {
        return next(
          new AppError(
            `Start date ${effectiveStartDate.toDateString()} is not a working day for ${workShift.name}`,
            400,
          ),
        );
      }

      let parsedWeekDays = [];
      if (weekDays) {
        let days = [];
        try {
          if (typeof weekDays === "string") {
            days = JSON.parse(weekDays);
          } else if (Array.isArray(weekDays)) {
            days = weekDays;
          }
        } catch (error) {
          if (typeof weekDays === "string") {
            days = weekDays
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean);
          }
        }
        if (Array.isArray(days)) {
          parsedWeekDays = days.map((day) => day.toLowerCase());
        }
      }
      newTask = new RecurringTask({
        ...commonFields,
        frequency: modelFrequency,
        weekDays: parsedWeekDays,
        endDate: cleanField(recurrenceEndDate)
          ? parseDateIST(recurrenceEndDate)
          : null,
        attachmentFile: req.files
          ? req.files.map((file) => `${req.uploadFolder}/${file.filename}`)
          : [],
      });
    } else {
      // 🔥 DELEGATION
      newTask = new DelegationTask({
        ...commonFields,
        status: calculateStatus({ ...commonFields, completeStatus: false }),
        attachmentFile: req.files
          ? req.files.map((file) => `${req.uploadFolder}/${file.filename}`)
          : [],
        taskDoneBy: null,
      });
    }

    // 🔥 Set visibility: false initially (cron will enable at shift start)
    newTask.isVisible = false;

    // Save
    await newTask.save();

    // // 🔌 Socket.IO Threading: Create Conversation + Notify
    // const creatorId =  req.cookies.userId;
    // const participants = [creatorId, assigneeId];
    // const conversation = await Conversation.create({
    //   taskId: newTask._id,
    //   taskType: newTask.taskType || "DelegationTask",
    //   participants: participants,
    // });
    // newTask.conversationId = conversation._id;
    // await newTask.save();

    // // Notification for assignee (except creator)
    // if (creatorId.toString() !== assigneeId.toString()) {
    //   await Notifications.create({
    //     user: assigneeId,
    //     type: "TASK_UPDATE",
    //     title: `New Task Assigned: ${newTask.title}`,
    //     description: `Task ${newTask.TaskId} created by you`,
    //     relatedId: newTask._id,
    //   });

    //   // Emit real-time
    //   const io = getIO();
    //   io.to(assigneeId.toString()).emit("new-task-assigned", {
    //     task: newTask,
    //     conversationId: conversation._id,
    //   });
    // }

    await createLog({
      action: "CREATE",
      module: "TASK",
      documentId: newTask._id,
      performedBy: req.cookies.userId || req.user._id || null,
      newData: newTask,
      message: `Task Created | Title: ${newTask.title} | ID: ${newTask.TaskId} | WorkShift: ${workShift.name} | Visible: ${newTask.isVisible}`,
    });
    createdTasks.push(newTask);
  }

  // Response
  const defaultMessage = `${createdTasks.length} Task(s) created successfully`;
  res.status(201).json({
    success: true,
    message: defaultMessage,
    data:
      createdTasks.length === 1
        ? normalizeTask(createdTasks[0])
        : createdTasks.map(normalizeTask),
  });
});
// ---------------------------------------------------------
// EXPORT TASKS
// ---------------------------------------------------------
const normalizeStatus = (status) => {
  if (!status) return status;

  const map = {
    pending: "Pending",
    completed: "Completed",
    delayed: "Delayed",
    upcoming: "Upcoming",
    overdue: "Overdue",
  };

  return map[status.toLowerCase()] || status;
};
export const exportTasks = handleAsync(async (req, res, next) => {
  const { format = "csv", tabType, assignedTo, status, search } = req.body;
  let filter = {};

  // ✅ Apply same logic as frontend
  if (tabType === "one-time") {
    filter = {
      $or: [
        { taskType: "DelegationTask" },
        {
          $and: [
            { recurrenceFrequency: { $exists: false } },
            { taskType: { $ne: "RecurringTask" } },
          ],
        },
      ],
    };
  }

  if (tabType === "recurrence") {
    filter = {
      $or: [
        { taskType: "RecurringTask" },
        { recurrenceFrequency: { $exists: true, $ne: null } },
      ],
    };
  }
  if (search) {
    const searchQuery = {
      $or: [{ title: { $regex: search, $options: "i" } }, { TaskId: search }],
    };

    if (filter.$or) {
      filter = { $and: [filter, searchQuery] };
    } else {
      filter = searchQuery;
    }
  }
  // ✅ 2. Assigned To Filter
  if (assignedTo && assignedTo !== "all") {
    if (Array.isArray(assignedTo)) {
      // multiple users
      filter.assignedTo = { $in: assignedTo };
    } else {
      // single user
      filter.assignedTo = { $in: [assignedTo] };
    }
  }

  // ✅ 3. Status Filter
  if (status && status !== "all") {
    const formattedStatus = normalizeStatus(status);

    // support single OR multiple
    if (Array.isArray(formattedStatus)) {
      filter.status = { $in: formattedStatus };
    } else {
      filter.status = formattedStatus;
    }
  }

  const tasks = await Task.find(filter)
    .populate("assignedTo", "name email")
    .populate("departmentOfAssignToUser", "name")
    .populate("assignedBy", "name email")
    .lean();

  if (tasks.length === 0) {
    return next(new AppError("No tasks to export", 404));
  }

  const fields = [
    { label: "Task ID", value: "TaskId" },
    { label: "Title", value: "title" },
    { label: "Description", value: "description" },
    { label: "Status", value: "status" },
    { label: "Assigned To Name", value: "assignedTo.name" },
    { label: "Assigned To Email", value: "assignedTo.email" },
    { label: "Assigned By Name", value: "assignedBy.name" },
    { label: "Assigned By Email", value: "assignedBy.email" },
    { label: "Department", value: "departmentOfAssignToUser.name" },
    { label: "Start Date", value: "startDate" },
    { label: "Due Date", value: "dueDate" },
    { label: "Task Type", value: "taskType" },
    { label: "Frequency", value: "frequency" },
  ];

  const processedTasks = tasks.map((task) => {
    let flatTask = {};
    fields.forEach((field) => {
      // Manual nesting resolver
      if (field.value.includes(".")) {
        const keys = field.value.split(".");
        flatTask[field.label] = keys.reduce(
          (obj, key) => (obj && obj[key] !== "undefined" ? obj[key] : ""),
          task,
        );
      } else {
        flatTask[field.label] = task[field.value];
      }
    });
    return flatTask;
  });

  if (format === "xlsx") {
    const ws = XLSX.utils.json_to_sheet(processedTasks);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Tasks");
    const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

    res.header(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.attachment("tasks.xlsx");
    res.send(buffer);
  } else {
    const json2csvParser = new Parser({ fields: fields.map((f) => f.label) });
    const csv = json2csvParser.parse(processedTasks);

    res.header("Content-Type", "text/csv");
    res.attachment("tasks.csv");
    res.send(csv);
  }
});

// ---------------------------------------------------------
// GET ALL TASKS FOR DASHBOARD
// ---------------------------------------------------------
export const getAllTasksWithStats = async (req, res) => {
  try {
    const { filterType, userId, role } = req.body;
    // filterType = today | week | month

    let dateFilter = {};

    const now = new Date();

    // 👉 TODAY
    if (filterType === "today") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);

      const end = new Date();
      end.setHours(23, 59, 59, 999);

      dateFilter = {
        createdAt: { $gte: start, $lte: end },
      };
    }

    // 👉 THIS WEEK
    if (filterType === "week") {
      const start = new Date();
      const day = start.getDay(); // 0-6
      const diff = start.getDate() - day + (day === 0 ? -6 : 1); // Monday start

      const weekStart = new Date(start.setDate(diff));
      weekStart.setHours(0, 0, 0, 0);

      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekEnd.setHours(23, 59, 59, 999);

      dateFilter = {
        createdAt: { $gte: weekStart, $lte: weekEnd },
      };
    }

    // 👉 THIS MONTH
    if (filterType === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);

      dateFilter = {
        createdAt: { $gte: start, $lte: end },
      };
    }
    // =========================
    // 👥 ROLE BASED FILTER (ONLY LOGGED USER)
    // =========================
    const andConditions = [];

    if (role === "Admin" || role === "Owner") {
      // full access → no restriction
    } else if (role === "Sr. Manager") {
      const srManagerId = userId;

      // 1. Get Managers under Sr Manager
      const managers = await User.find({
        reportingManager: srManagerId,
      }).select("_id");

      const managerIds = managers.map((m) => m._id);

      // 2. Get Members under those Managers
      const members = await User.find({
        reportingManager: { $in: managerIds },
      }).select("_id");

      const memberIds = members.map((m) => m._id);

      // 3. Combine all IDs
      const allIds = [srManagerId, ...managerIds, ...memberIds];

      // 4. Apply condition
      andConditions.push({
        $or: [{ assignedBy: { $in: allIds } }, { assignedTo: { $in: allIds } }],
      });
    } else if (role === "Manager") {
      const managerId = userId;

      // 1. Get Members under this Manager
      const memberUsers = await User.find({
        reportingManager: managerId,
      })
        .populate("role", "name")
        .select("_id role");

      const memberIds = memberUsers
        .filter((u) => u.role?.name === "Member")
        .map((u) => u._id);

      // 2. Combine manager + members
      const allIds = [managerId, ...memberIds];

      // 3. Apply condition (IMPORTANT)
      andConditions.push({
        $or: [
          { assignedBy: { $in: allIds } }, // created by manager or members
          { assignedTo: { $in: allIds } }, // assigned to manager or members
        ],
      });
    } else {
      // 👤 Member
      andConditions.push({
        assignedTo: userId,
      });
    }

    // =========================
    // 🧠 FINAL FILTER
    // =========================
    const filter = {
      ...dateFilter,
      ...(andConditions.length > 0 && { $and: andConditions }),
    };
    // 👉 FETCH ALL TASKS
    const tasks = await Task.find(filter)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .populate("departmentOfAssignToUser", "name")
      .populate("dependencyConfig.taskDependent", "title")
      .sort({ createdAt: -1 });

    //**FMS INSTANCE TASK COUNTS */
    const fmsFilter = {};

    // 👉 Apply SAME ROLE FILTER LOGIC
    if (andConditions.length > 0) {
      fmsFilter.$and = andConditions.map((cond) => {
        // map assignedBy → updatedBy for FMS
        if (cond.$or) {
          return {
            $or: cond.$or.map((c) => ({
              ...(c.assignedBy && { updatedBy: c.assignedBy }),
              ...(c.assignedTo && { assignedTo: c.assignedTo }),
            })),
          };
        }
        return cond;
      });
    }

    // 👉 Apply DATE FILTER (use plannedStartDate)
    if (dateFilter.createdAt) {
      fmsFilter.plannedStartDate = dateFilter.createdAt;
    }

    // 👉 FETCH FMS TASKS
    const fmsTasks = await FmsInstanceTask.find(fmsFilter)
      .populate("assignedTo", "name email department")
      .populate("updatedBy", "name email")
      .populate("departmentOfAssignToUser", "name")
      .sort({ createdAt: -1 });
    const mappedFmsTasks = fmsTasks.map((task) => ({
      _id: task._id,
      TaskId: task.taskId,
      title: task.description,
      description: task.description,
      startDate: task.plannedStartDate,
      dueDate: task.plannedDueDate,
      status: task.status,
      assignedTo: task.assignedTo,
      assignedBy: task.updatedBy || null,
      departmentOfAssignToUser: task.departmentOfAssignToUser,
      taskType: "FmsInstanceTask",
      createdAt: task.createdAt,
    }));
    const allTasks = [...tasks, ...mappedFmsTasks];
    // 👉 STATUS COUNTS
    // 👉 STATUS COUNTS (PURE JS - SAFE)
    const statusCounts = {
      Pending: allTasks.filter((t) => t.status === "Pending").length,
      Completed: allTasks.filter((t) => t.status === "Completed").length,
      Delayed: allTasks.filter((t) => t.status === "Delayed").length,
      Upcoming: allTasks.filter((t) => t.status === "Upcoming").length,
      Overdue: allTasks.filter((t) => t.status === "Overdue").length,
    };

    // console.log("TOTAL TASKS:", tasks.length);
    // console.log("Counts:", statusCounts);

    return res.status(200).json({
      success: true,
      total: allTasks.length, // ✅ now includes FMS
      counts: statusCounts, // ✅ includes FMS
      data: allTasks,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tasks",
    });
  }
};
// export const getAllTasksWithStats = async (req, res) => {
//   try {
//     const { filterType, userId, role } = req.body;

//     let dateFilter = {};
//     const now = new Date();

//     // =========================
//     // 📅 DATE FILTER
//     // =========================
//     if (filterType === "today") {
//       const start = new Date();
//       start.setHours(0, 0, 0, 0);

//       const end = new Date();
//       end.setHours(23, 59, 59, 999);

//       dateFilter = { createdAt: { $gte: start, $lte: end } };
//     }

//     if (filterType === "week") {
//       const start = new Date();
//       const day = start.getDay();
//       const diff = start.getDate() - day + (day === 0 ? -6 : 1);

//       const weekStart = new Date(start.setDate(diff));
//       weekStart.setHours(0, 0, 0, 0);

//       const weekEnd = new Date(weekStart);
//       weekEnd.setDate(weekStart.getDate() + 6);
//       weekEnd.setHours(23, 59, 59, 999);

//       dateFilter = { createdAt: { $gte: weekStart, $lte: weekEnd } };
//     }

//     if (filterType === "month") {
//       const start = new Date(now.getFullYear(), now.getMonth(), 1);
//       const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

//       start.setHours(0, 0, 0, 0);
//       end.setHours(23, 59, 59, 999);

//       dateFilter = { createdAt: { $gte: start, $lte: end } };
//     }

//     // =========================
//     // 👥 ROLE BASED FILTER (ONLY LOGGED USER)
//     // =========================
//     const andConditions = [];

//     if (role === "Admin" || role === "Owner") {
//       // full access → no restriction
//     } else if (role === "Sr. Manager") {
//       const srManagerId = userId;

//       // 1. Get Managers under Sr Manager
//       const managers = await User.find({
//         reportingManager: srManagerId,
//       }).select("_id");

//       const managerIds = managers.map((m) => m._id);

//       // 2. Get Members under those Managers
//       const members = await User.find({
//         reportingManager: { $in: managerIds },
//       }).select("_id");

//       const memberIds = members.map((m) => m._id);

//       // 3. Combine all IDs
//       const allIds = [srManagerId, ...managerIds, ...memberIds];

//       // 4. Apply condition
//       andConditions.push({
//         $or: [{ assignedBy: { $in: allIds } }, { assignedTo: { $in: allIds } }],
//       });
//     } else if (role === "Manager") {
//       const managerId = userId;

//       // 1. Get Members under this Manager
//       const memberUsers = await User.find({
//         reportingManager: managerId,
//       })
//         .populate("role", "name")
//         .select("_id role");

//       const memberIds = memberUsers
//         .filter((u) => u.role?.name === "Member")
//         .map((u) => u._id);

//       // 2. Combine manager + members
//       const allIds = [managerId, ...memberIds];

//       // 3. Apply condition (IMPORTANT)
//       andConditions.push({
//         $or: [
//           { assignedBy: { $in: allIds } }, // created by manager or members
//           { assignedTo: { $in: allIds } }, // assigned to manager or members
//         ],
//       });
//     } else {
//       // 👤 Member
//       andConditions.push({
//         assignedTo: userId,
//       });
//     }

//     // =========================
//     // 🧠 FINAL FILTER
//     // =========================
//     const filter = {
//       ...dateFilter,
//       ...(andConditions.length > 0 && { $and: andConditions }),
//     };

//     // =========================
//     // 📊 COUNTS + TOTAL
//     // =========================
//     const [counts, total] = await Promise.all([
//       Task.aggregate([
//         { $match: filter },
//         {
//           $group: {
//             _id: "$status",
//             count: { $sum: 1 },
//           },
//         },
//       ]),
//       Task.countDocuments(filter),
//     ]);

//     // =========================
//     // 📦 FORMAT COUNTS
//     // =========================
//     const statusCounts = {
//       Pending: 0,
//       Completed: 0,
//       Delayed: 0,
//       Upcoming: 0,
//       Overdue: 0,
//     };

//     counts.forEach((item) => {
//       statusCounts[item._id] = item.count;
//     });

//     // =========================
//     // 🚀 RESPONSE
//     // =========================
//     return res.status(200).json({
//       success: true,
//       total,
//       counts: statusCounts,
//     });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({
//       success: false,
//       message: "Failed to fetch tasks",
//     });
//   }
// };
//**for my task listing - FIXED taskType filtering */
export const filterTasks = handleAsync(async (req, res) => {
  const {
    userId,
    page = 1,
    limit = 10,
    search,
    filters = {},
    creatorOrAssignorId,
    departmentId,
    createdBy,
    assignedBy,
    startDate,
    endDate,
  } = req.body;

  const skip = (page - 1) * limit;

  const { stat, taskCategory, status, taskType } = filters;
  // Validate dates if provided
  // if (startDate && !startDate.match(/^\\d{4}-\\d{2}-\\d{2}$/)) {
  //   console.log(startDate)
  //   return res.status(400).json({ success: false, message: "startDate must be YYYY-MM-DD" });
  // }
  // if (endDate && !endDate.match(/^\\d{4}-\\d{2}-\\d{2}$/)) {
  //   return res.status(400).json({ success: false, message: "endDate must be YYYY-MM-DD" });
  // }

  const query = {};
  const andConditions = [];

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());
  if (creatorOrAssignorId) {
    andConditions.push({
      $or: [
        { createdBy: creatorOrAssignorId },
        { assignedBy: creatorOrAssignorId },
      ],
    });
  } else {
    if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
      const usersInDept = await User.find({ department: departmentId }).select(
        "_id",
      );
      const userIds = usersInDept.map((u) => u._id);

      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        if (userIds.some((id) => id.equals(userId))) {
          andConditions.push({ assignedTo: userId });
        } else {
          return res.status(200).json({
            success: true,
            data: [],
            totalTasks: 0,
          });
        }
      } else {
        andConditions.push({ assignedTo: { $in: userIds } });
      }
    } else if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      andConditions.push({ assignedTo: userId });
    }

    if (createdBy) {
      andConditions.push({ createdBy });
    }
  }

  // 🔍 SEARCH
  if (search) {
    andConditions.push({
      $or: [{ title: { $regex: search, $options: "i" } }, { TaskId: search }],
    });
  }

  // 📊 STAT FILTER
  if (stat === "overdue") {
    andConditions.push({
      $or: [
        {
          taskType: "DelegationTask",
          dueDate: { $lt: todayStart },
        },
        {
          taskType: "RecurringTask",
          endDate: { $lt: todayStart },
        },
      ],
    });

    andConditions.push({
      status: { $ne: "Completed" },
    });
  }
  if (stat === "dueToday") {
    andConditions.push({
      dueDate: { $gte: todayStart, $lte: todayEnd },
    });
  }

  if (stat === "completed") {
    query.status = "Completed";
  }
  if (stat === "pending") {
    query.status = "Pending";
  }

  // 📌 TAB CATEGORY
  if (!stat) {
    if (taskCategory === "today_backlog") {
      const start = startOfDay(new Date());
      const end = endOfDay(new Date());
      andConditions.push({
        status: { $in: ["Pending", "Delayed", "Overdue"] },
      });
      andConditions.push({
        taskType: "DelegationTask",
      });
      andConditions.push({
        startDate: { $gte: start, $lte: end },
      });
    }

    if (taskCategory === "upcoming") {
      query.status = "Upcoming";
    }

    if (taskCategory === "completed") {
      query.status = "Completed";
    }
  }

  // 📊 STATUS FILTER
  if (status && status !== "all") {
    query.status = status;
  }

  // 🔁 TASK TYPE
  if (taskType) {
    query.taskType = taskType;
  }

  // 📅 DATE RANGE FILTER (startDate OR dueDate)
  // 📅 DATE RANGE FILTER (FIXED)
  if (startDate || endDate) {
    const filter = {};

    if (startDate) {
      filter.$gte = startOfDay(parseISO(startDate));
    }

    if (endDate) {
      filter.$lte = endOfDay(parseISO(endDate));
    }

    andConditions.push({
      startDate: filter, // ✅ start must be inside
    });

    andConditions.push({
      dueDate: filter, // ✅ due must be inside
    });
  }

  // ✅ MERGE CONDITIONS
  if (andConditions.length > 0) {
    query.$and = andConditions;
  }
  if (query.status !== "Upcoming") {
    query.isVisible = true;
  }
  // query.taskType = { $ne: "RecurringTask" };
  // 🚀 QUERY EXECUTION
  const [tasks, total] = await Promise.all([
    Task.find(query) // 🔥 Only visible tasks
      .populate("assignedTo", "name email department assignShift")
      .populate("assignedBy", "name email")
      .populate("departmentOfAssignToUser", "name")
      .populate("dependencyConfig.taskDependent", "title")
      .sort({ createdAt: -1 }),

    // .skip(skip)
    // .limit(limit)
    Task.countDocuments(query), // 🔥 Count only visible
  ]);
  //**get recurring task in upcoming section  */
  // 🔥 STEP 2: Get recurring TEMPLATES (not instances)
  const recurringQuery = {
    taskType: "RecurringTask",
  };

  // reuse same AND conditions except date + taskType
  if (andConditions.length > 0) {
    recurringQuery.$and = andConditions.filter((cond) => {
      // ❌ remove date filters
      return !(cond.startDate || cond.dueDate);
    });
  }
  const recurringTemplates = await Task.find({
    ...recurringQuery,
    taskType: "RecurringTask",
    // Apply your userId/departmentId filters here
    assignedTo: userId, // or your filter logic
    // isVisible: true,
    startDate: { $exists: true },
    frequency: { $ne: "Daily" },
  })
    .populate("assignedTo", "name email department assignShift")
    .populate("assignedBy", "name email")
    .populate("departmentOfAssignToUser", "name")
    .populate("dependencyConfig.taskDependent", "title")
    .lean();
  // 🔥 STEP 3: Project future occurrences (next 30 days)
  const futureRecurring = recurringTemplates
    .map((template) => {
      const nextDates = [];
      for (let i = 0; i < 365; i++) {
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + i);
        if (isTaskValidForToday(template, futureDate)) {
          nextDates.push(futureDate);
          break; // Only show next occurrence
        }
      }

      if (nextDates.length > 0) {
        return {
          ...template,
          status: "Upcoming",
          startDate: nextDates[0],
          dueDate: nextDates[0],
        };
      }
      return null;
    })
    .filter(Boolean);
  let filteredRecurring = futureRecurring;

  if (startDate || endDate) {
    const startBoundary = startDate ? startOfDay(parseISO(startDate)) : null;
    const endBoundary = endDate ? endOfDay(parseISO(endDate)) : null;

    filteredRecurring = futureRecurring.filter((task) => {
      const taskDate = new Date(task.virtualNextOccurrence || task.startDate);

      if (startBoundary && taskDate < startBoundary) return false;
      if (endBoundary && taskDate > endBoundary) return false;

      return true;
    });
  }
  // After calculating futureRecurring & filteredRecurring...

  // 🔥 APPLY SAME FILTERS as main query
  let finalVirtualRecurring = filteredRecurring;

  // 1. STATUS FILTER
  if (status && status !== "all") {
    finalVirtualRecurring = finalVirtualRecurring.filter(
      (task) => task.status === status,
    );
  }

  // 2. TASK TYPE FILTER
  if (taskType) {
    finalVirtualRecurring = finalVirtualRecurring.filter(
      (task) => task.taskType === taskType || task.isVirtualRecurring,
    );
  }

  // 3. OTHER FILTERS (search, stat, etc.)
  if (search) {
    finalVirtualRecurring = finalVirtualRecurring.filter((task) =>
      task.title.toLowerCase().includes(search.toLowerCase()),
    );
  }

  // MERGE
  // const allTasks = [...tasks, ...finalVirtualRecurring];

  // 🔥 STEP 4: MERGE in response
  //**GETING FMS TASKS */
  const fmsQuery = {};

  // USER FILTERS
  if (creatorOrAssignorId) {
    fmsQuery.$or = [
      { updatedBy: creatorOrAssignorId },
      { assignedTo: creatorOrAssignorId },
    ];
  } else if (departmentId) {
    const usersInDept = await User.find({ department: departmentId }).select(
      "_id",
    );
    fmsQuery.assignedTo = { $in: usersInDept.map((u) => u._id) };
  } else if (userId) {
    fmsQuery.assignedTo = userId;
  }
  if (createdBy) fmsQuery.updatedBy = createdBy;

  // SEARCH
  if (search) {
    fmsQuery.$or = [
      { description: { $regex: search, $options: "i" } },
      { taskId: search },
    ];
  }

  // STATUS
  if (status && status !== "all") fmsQuery.status = status;

  // TASK TYPE (ignore for FMS)
  // delete query.taskType;

  // DATE RANGE
  if (startDate || endDate) {
    const dateFilter = {};
    if (startDate) dateFilter.$gte = startOfDay(parseISO(startDate));
    if (endDate) dateFilter.$lte = endOfDay(parseISO(endDate));
    fmsQuery.$or = [
      { plannedStartDate: dateFilter },
      { plannedDueDate: dateFilter },
    ];
  }

  // =========================
  // 📊 STATUS / STAT FILTER
  // =========================
  if (stat === "overdue") {
    fmsQuery.plannedDueDate = { $lt: todayStart };
    fmsQuery.status = { $ne: "Completed" };
  }

  if (stat === "dueToday") {
    fmsQuery.plannedDueDate = { $gte: todayStart, $lte: todayEnd };
  }

  if (stat === "completed") {
    fmsQuery.status = "Completed";
  }

  if (stat === "pending") {
    fmsQuery.status = "Pending";
  }

  // =========================
  // 📌 TAB CATEGORY
  // =========================
  if (!stat) {
    if (taskCategory === "today_backlog") {
      const start = startOfDay(new Date());
      const end = endOfDay(new Date());

      fmsQuery.status = { $in: ["Pending", "Delayed", "Overdue"] };
      fmsQuery.plannedStartDate = { $gte: start, $lte: end };
    }

    if (taskCategory === "upcoming") {
      fmsQuery.status = "Upcoming";
    }

    if (taskCategory === "completed") {
      fmsQuery.status = "Completed";
    }
  }

  // =========================
  // 📊 DIRECT STATUS FILTER
  // =========================
  if (status && status !== "all") {
    fmsQuery.status = status;
  }
  // VISIBILITY
  // if (query.status !== "Upcoming") fmsQuery.isVisible = true;
  const [fmsTasks, fmsTotal] = await Promise.all([
    FmsInstanceTask.find(fmsQuery)
      .populate("assignedTo", "name email department assignShift")
      .populate("assignedBy", "name email")
      .populate("updatedBy", "name email") // use as assignedBy fallback
      .populate("departmentOfAssignToUser", "name")
      .sort({ createdAt: -1 })
      .lean(),
    // .skip(skip)
    // .limit(limit)
    FmsInstanceTask.countDocuments(fmsQuery),
  ]);
  const mappedFmsTasks = fmsTasks.map((task) => ({
    ...task,
    _id: task._id,
    TaskId: task.taskId,

    title: task.description,
    description: task.description,

    startDate: task.plannedStartDate,
    dueDate: task.plannedDueDate,

    status: task.status,

    assignedTo: task.assignedTo,
    assignedBy: task.assignedBy || null,

    departmentOfAssignToUser: task.departmentOfAssignToUser,

    taskType: "FmsInstanceTask",

    isVisible: task.isVisible,

    checklist: task.checklist || [],

    createdAt: task.createdAt,
  }));
  let allTasks = [];
  if (taskType === "FmsInstanceTask") {
    allTasks = [...mappedFmsTasks];
  }

  // ✅ CASE 2: Only Normal Tasks (Delegation + Recurring created ones)
  else if (taskType) {
    allTasks = [...tasks];
  }

  // ✅ CASE 3: No filter → show ALL
  else {
    allTasks = [...tasks, ...mappedFmsTasks];
  }
  // const actualTotal = total + fmsTotal;
  const totalTasks = allTasks.length;

  const paginatedTasks = allTasks.slice(skip, skip + Number(limit));
  res.json({
    success: true,
    // data: tasks,
    data: paginatedTasks,
    upcomingRecurringTasks: finalVirtualRecurring,
    totalTasks: totalTasks,
    currentPage: page,
    totalPages: Math.ceil(totalTasks / limit),
  });
});
//**get my task stats */
export const getTaskStats = handleAsync(async (req, res) => {
  const { userId, creatorOrAssignorId, departmentId, createdBy } = req.body;

  const baseConditions = [];

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

  // =========================================================
  // 👤 USER / DEPARTMENT FILTER (same as before)
  // =========================================================
  if (creatorOrAssignorId) {
    baseConditions.push({
      $or: [
        { createdBy: creatorOrAssignorId },
        { assignedBy: creatorOrAssignorId },
      ],
    });
  } else {
    if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
      const usersInDept = await User.find({ department: departmentId }).select(
        "_id",
      );
      const userIds = usersInDept.map((u) => u._id);

      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        if (userIds.some((id) => id.equals(userId))) {
          baseConditions.push({ assignedTo: userId });
        } else {
          return res.json({
            success: true,
            stats: { total: 0, overdue: 0, pending: 0, completed: 0 },
          });
        }
      } else {
        baseConditions.push({ assignedTo: { $in: userIds } });
      }
    } else if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      baseConditions.push({ assignedTo: userId });
    }

    if (createdBy) {
      baseConditions.push({ createdBy });
    }
  }

  // =========================================================
  // 🧱 BASE QUERY
  // =========================================================
  const baseQuery = {};

  if (baseConditions.length > 0) {
    baseQuery.$and = baseConditions;
  }

  // visibility same as main API
  baseQuery.isVisible = true;

  // =========================================================
  // 🚀 PARALLEL COUNTS (MATCHING YOUR MAIN LOGIC)
  // =========================================================
  const [total, completed, pending, overdue] = await Promise.all([
    // TOTAL
    Task.countDocuments(baseQuery),

    // COMPLETED
    Task.countDocuments({
      ...baseQuery,
      status: "Completed",
    }),

    // PENDING
    Task.countDocuments({
      ...baseQuery,
      status: "Pending",
    }),

    // OVERDUE (🔥 SAME LOGIC AS filterTasks)
    Task.countDocuments({
      ...baseQuery,
      $and: [
        ...(baseQuery.$and || []),
        {
          $or: [
            {
              taskType: "DelegationTask",
              dueDate: { $lt: todayStart },
            },
            {
              taskType: "RecurringTask",
              endDate: { $lt: todayStart },
            },
          ],
        },
        {
          status: { $ne: "Completed" },
        },
      ],
    }),
  ]);

  //**FMS Stats */
  const fmsQuery = {};

  // USER FILTERS
  if (creatorOrAssignorId) {
    fmsQuery.$or = [
      { updatedBy: creatorOrAssignorId },
      { assignedTo: creatorOrAssignorId },
    ];
  } else if (departmentId) {
    const usersInDept = await User.find({ department: departmentId }).select(
      "_id",
    );
    fmsQuery.assignedTo = { $in: usersInDept.map((u) => u._id) };
  } else if (userId) {
    fmsQuery.assignedTo = userId;
  }

  if (createdBy) fmsQuery.updatedBy = createdBy;

  // visibility same as tasks
  // fmsQuery.isVisible = true;
  const [fmsTotal, fmsCompleted, fmsPending, fmsOverdue] = await Promise.all([
    // TOTAL
    FmsInstanceTask.countDocuments(fmsQuery),

    // COMPLETED
    FmsInstanceTask.countDocuments({
      ...fmsQuery,
      status: "Completed",
    }),

    // PENDING
    FmsInstanceTask.countDocuments({
      ...fmsQuery,
      status: "Pending",
    }),

    // OVERDUE
    FmsInstanceTask.countDocuments({
      ...fmsQuery,
      plannedDueDate: { $lt: todayStart },
      status: { $ne: "Completed" },
    }),
  ]);
  // =========================================================
  // 📤 RESPONSE
  // =========================================================
  // res.json({
  //   success: true,
  //   stats: {
  //     total,
  //     overdue,
  //     pending,
  //     completed,
  //   },
  // });
  res.json({
    success: true,
    stats: {
      total: total + fmsTotal,
      completed: completed + fmsCompleted,
      pending: pending + fmsPending,
      overdue: overdue + fmsOverdue,
    },
  });
});
//**for role based task listing */
export const getRoleBasedTasks = handleAsync(async (req, res) => {
  const {
    userId,
    role,
    departmentId,
    page = 1,
    limit = 10,
    search,
    filters = {},
    assignedBy,
    selectedDoer,
    selectedManager,
    selectedSrManager,
  } = req.body;

  const skip = (page - 1) * limit;

  const { stat, taskCategory, status, taskType } = filters;

  const query = {};
  const andConditions = [];

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

  // =========================
  // 👥 ROLE BASED ACCESS (NO DEPARTMENT)
  // =========================

  if (role === "Admin" || role === "Owner") {
    // ✅ Full access

    if (selectedDoer && selectedDoer !== "all") {
      andConditions.push({ assignedTo: selectedDoer });
    }

    if (selectedManager && selectedManager !== "all") {
      andConditions.push({
        $or: [
          { assignedBy: selectedManager }, // created by manager
          { assignedTo: selectedManager }, // assigned to manager
        ],
      });
    }

    if (selectedSrManager && selectedSrManager !== "all") {
      andConditions.push({
        $or: [
          { assignedBy: selectedSrManager }, // created by sr.manager
          { assignedTo: selectedSrManager }, // assigned to sr.manager
        ],
      });
      // andConditions.push({ assignedTo: selectedSrManager });
    }
  } else if (role === "Sr. Manager") {
    const srManagerId = userId;

    // 1. Get Managers under Sr Manager
    const managers = await User.find({
      reportingManager: srManagerId,
    }).select("_id");

    const managerIds = managers.map((m) => m._id);

    // 2. Get Members under those Managers
    const members = await User.find({
      reportingManager: { $in: managerIds },
    }).select("_id");

    const memberIds = members.map((m) => m._id);

    // 3. Combine all IDs
    const allIds = [srManagerId, ...managerIds, ...memberIds];

    // 4. Apply condition
    andConditions.push({
      $or: [{ assignedBy: { $in: allIds } }, { assignedTo: { $in: allIds } }],
    });

    // 🎯 Optional Filters

    if (selectedManager && selectedManager !== "all") {
      andConditions.push({
        $or: [{ assignedBy: selectedManager }, { assignedTo: selectedManager }],
      });
    }

    if (selectedDoer && selectedDoer !== "all") {
      andConditions.push({
        assignedTo: selectedDoer,
      });
    }
  } else if (role === "Manager") {
    const managerId = userId;

    // 1. Get Members under this Manager
    const memberUsers = await User.find({
      reportingManager: managerId,
    })
      .populate("role", "name")
      .select("_id role");

    const memberIds = memberUsers
      .filter((u) => u.role?.name === "Member")
      .map((u) => u._id);

    // 2. Combine manager + members
    const allIds = [managerId, ...memberIds];

    // 3. Apply condition (IMPORTANT)
    andConditions.push({
      $or: [
        { assignedBy: { $in: allIds } }, // created by manager or members
        { assignedTo: { $in: allIds } }, // assigned to manager or members
      ],
    });

    // 🎯 Optional Filters

    if (selectedDoer && selectedDoer !== "all") {
      andConditions.push({
        assignedTo: selectedDoer,
      });
    }
  } else {
    // 👤 Member → Only self
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      andConditions.push({ assignedTo: userId });
    }
  }

  // =========================
  // 🔍 SEARCH
  // =========================
  if (search) {
    andConditions.push({
      $or: [{ title: { $regex: search, $options: "i" } }, { TaskId: search }],
    });
  }

  // =========================
  // 📊 STAT FILTER
  // =========================
  if (stat === "overdue") {
    andConditions.push({
      $or: [
        {
          taskType: "DelegationTask",
          dueDate: { $lt: todayEnd },
        },
        {
          taskType: "RecurringTask",
          endDate: { $lt: todayEnd },
        },
      ],
    });

    andConditions.push({
      status: { $ne: "Completed" },
    });
  }

  if (stat === "dueToday") {
    andConditions.push({
      dueDate: { $gte: todayStart, $lte: todayEnd },
    });
  }

  if (stat === "completed") {
    andConditions.push({
      status: "Completed",
    });
  }

  // =========================
  // 📌 TAB FILTER
  // =========================
  if (!stat) {
    if (taskCategory === "today_backlog") {
      const start = startOfDay(new Date());
      const end = endOfDay(new Date());
      andConditions.push({
        status: { $in: ["Pending", "Delayed", "Overdue"] },
      });
      andConditions.push({
        taskType: "DelegationTask",
      });
      andConditions.push({
        startDate: { $gte: start, $lte: end },
      });
    }

    if (taskCategory === "upcoming") {
      query.status = "Upcoming";
    }

    if (taskCategory === "completed") {
      query.status = "Completed";
    }
  }

  // =========================
  // 📊 STATUS FILTER
  // =========================
  if (status && status !== "all") {
    andConditions.push({ status });
  }

  // =========================
  // 🔁 TASK TYPE
  // =========================
  if (taskType) {
    andConditions.push({ taskType });
  }

  // =========================
  // 👤 ASSIGNED BY FILTER
  // =========================
  if (assignedBy && mongoose.Types.ObjectId.isValid(assignedBy)) {
    andConditions.push({ assignedBy });
  }

  // =========================
  // ✅ FINAL QUERY
  // =========================
  if (andConditions.length > 0) {
    query.$and = andConditions;
  }
  // =========================
  // 🧩 FMS QUERY (NEW)
  // =========================
  const fmsQuery = {};
  const fmsAndConditions = [];

  // 👥 ROLE BASED ACCESS (SAME LOGIC)
  if (role === "Admin" || role === "Owner") {
    if (selectedDoer && selectedDoer !== "all") {
      fmsAndConditions.push({ assignedTo: selectedDoer });
    }

    if (selectedManager && selectedManager !== "all") {
      fmsAndConditions.push({
        $or: [{ updatedBy: selectedManager }, { assignedTo: selectedManager }],
      });
    }

    if (selectedSrManager && selectedSrManager !== "all") {
      fmsAndConditions.push({
        $or: [
          { updatedBy: selectedSrManager },
          { assignedTo: selectedSrManager },
        ],
      });
    }
  } else if (role === "Sr. Manager") {
    const managers = await User.find({
      reportingManager: userId,
    }).select("_id");

    const managerIds = managers.map((m) => m._id);

    const members = await User.find({
      reportingManager: { $in: managerIds },
    }).select("_id");

    const memberIds = members.map((m) => m._id);

    const allIds = [userId, ...managerIds, ...memberIds];

    fmsAndConditions.push({
      assignedTo: { $in: allIds },
    });
  } else if (role === "Manager") {
    const members = await User.find({
      reportingManager: userId,
    }).select("_id");

    const memberIds = members.map((m) => m._id);

    const allIds = [userId, ...memberIds];

    fmsAndConditions.push({
      assignedTo: { $in: allIds },
    });
  } else {
    fmsAndConditions.push({ assignedTo: userId });
  }

  // 🔍 SEARCH
  if (search) {
    fmsAndConditions.push({
      $or: [
        { description: { $regex: search, $options: "i" } },
        { taskId: search },
      ],
    });
  }

  // 📊 STATUS
  if (status && status !== "all") {
    fmsAndConditions.push({ status });
  }

  // 📊 STAT FILTER
  if (stat === "overdue") {
    fmsAndConditions.push({
      plannedDueDate: { $lt: todayStart },
    });
    fmsAndConditions.push({
      status: { $ne: "Completed" },
    });
  }

  if (stat === "dueToday") {
    fmsAndConditions.push({
      plannedDueDate: { $gte: todayStart, $lte: todayEnd },
    });
  }

  // 📌 TAB FILTER
  if (!stat) {
    if (taskCategory === "today_backlog") {
      fmsAndConditions.push({
        status: { $in: ["Pending", "Delayed", "Overdue"] },
      });

      fmsAndConditions.push({
        plannedStartDate: { $gte: todayStart, $lte: todayEnd },
      });
    }

    if (taskCategory === "upcoming") {
      fmsAndConditions.push({ status: "Upcoming" });
    }

    if (taskCategory === "completed") {
      fmsAndConditions.push({ status: "Completed" });
    }
  }

  // FINAL MERGE
  if (fmsAndConditions.length > 0) {
    fmsQuery.$and = fmsAndConditions;
  }
  // =========================
  // 🚀 EXECUTE
  // =========================
  // const [tasks, total] = await Promise.all([
  //   Task.find(query)
  //     .populate("assignedTo", "name email department")
  //     .populate("assignedBy", "name email")
  //     .populate("departmentOfAssignToUser", "name")
  //     .populate("dependencyConfig.taskDependent", "title")
  //     .sort({ createdAt: -1 })
  //     .skip(skip)
  //     .limit(limit),

  //   Task.countDocuments(query),
  // ]);
  const [tasks, total, fmsTasks, fmsTotal] = await Promise.all([
    Task.find(query)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .populate("departmentOfAssignToUser", "name")
      .populate("dependencyConfig.taskDependent", "title")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),

    Task.countDocuments(query),

    FmsInstanceTask.find(fmsQuery)
      .populate("assignedTo", "name email department assignShift")
      .populate("assignedBy", "name email")
      .populate("updatedBy", "name email")
      .populate("departmentOfAssignToUser", "name")
      .sort({ createdAt: -1 })
      .lean(),

    FmsInstanceTask.countDocuments(fmsQuery),
  ]);
  const mappedFmsTasks = fmsTasks.map((task) => ({
    ...task,
    _id: task._id,
    TaskId: task.taskId,

    title: task.description,
    description: task.description,

    startDate: task.plannedStartDate,
    dueDate: task.plannedDueDate,

    status: task.status,

    assignedTo: task.assignedTo,
    assignedBy: task.assignedBy || null,

    departmentOfAssignToUser: task.departmentOfAssignToUser,

    taskType: "FmsInstanceTask",

    isVisible: task.isVisible,

    checklist: task.checklist || [],

    createdAt: task.createdAt,
  }));
  let allTasks = [];

  if (taskType === "FmsInstanceTask") {
    allTasks = [...mappedFmsTasks];
  } else if (taskType) {
    allTasks = [...tasks];
  } else {
    allTasks = [...tasks, ...mappedFmsTasks];
  }

  const totalTasks = allTasks.length;

  res.json({
    success: true,
    data: allTasks,
    totalTasks,
    currentPage: page,
    totalPages: Math.ceil(totalTasks / limit),
  });
  // res.json({
  //   success: true,
  //   data: tasks,
  //   totalTasks: total,
  //   currentPage: page,
  //   totalPages: Math.ceil(total / limit),
  // });
});
// ---------------------------------------------------------
// GET ALL TASKS
// ---------------------------------------------------------
export const getAllTasks = handleAsync(async (req, res, next) => {
  const {
    search,
    status,
    userId,
    createdBy,
    departmentId,
    startDate,
    endDate,
    dateFilter,
    creatorOrAssignorId, // New parameter for tasks created by OR assigned by
    page = 1, // Default to page 1
    limit = 10, // Default to 10 items per page
    taskCategory, // New parameter for filtering by 'today', 'upcoming', 'completed'
    type,
  } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  let tasks = [];
  let total = 0;

  const filterQuery = {};
  const today = startOfDay(new Date());

  if (creatorOrAssignorId) {
    // If creatorOrAssignorId is provided, apply an OR condition
    filterQuery.$or = [
      { createdBy: creatorOrAssignorId },
      { assignedBy: creatorOrAssignorId },
    ];
  } else {
    // Existing logic for userId and createdBy if creatorOrAssignorId is not present
    if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
      const usersInDept = await User.find({ department: departmentId }).select(
        "_id",
      );
      const userIds = usersInDept.map((u) => u._id);

      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        if (userIds.some((id) => id.equals(userId)))
          filterQuery.assignedTo = userId;
        else
          return res
            .status(200)
            .json({ success: true, data: [], totalTasks: 0 });
      } else {
        filterQuery.assignedTo = { $in: userIds };
      }
    } else if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      filterQuery.assignedTo = userId;
    }

    if (createdBy) filterQuery.createdBy = createdBy;
  } // This closing brace for the `else` block was misplaced.
  if (taskCategory) {
    let categoryFilter = {};

    if (taskCategory === "today_backlog") {
      const start = startOfDay(new Date());
      const end = endOfDay(new Date());

      categoryFilter = {
        $and: [
          {
            status: { $in: ["Pending", "Delayed", "Overdue"] },
          },
          {
            startDate: {
              $gte: start,
              $lte: end,
            },
          },
        ],
      };
    }

    if (taskCategory === "upcoming") {
      categoryFilter.status = "Upcoming";
    }

    if (taskCategory === "completed") {
      categoryFilter.status = "Completed";
    }

    if (type) {
      if (categoryFilter.$and) {
        categoryFilter.$and.push({ taskType: type });
      } else {
        categoryFilter = {
          $and: [categoryFilter, { taskType: type }],
        };
      }
    }

    // ✅ SAFE MERGE
    if (Object.keys(filterQuery).length > 0) {
      filterQuery.$and = filterQuery.$and || [];
      filterQuery.$and.push(categoryFilter);
    } else {
      Object.assign(filterQuery, categoryFilter);
    }
  }
  if (dateFilter) {
    if (dateFilter === "overdue") {
      // Tasks with a due date before today
      filterQuery.dueDate = { $lt: today };
    } else if (dateFilter === "dueToday") {
      // Tasks with a due date of exactly today
      filterQuery.dueDate = {
        $gte: today,
        $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000),
      };
    }
  }

  // --- NEW: Handle Status, Date, and Category Filters ---
  if (status && status !== "all") {
    filterQuery.status = status;
  }

  if (search) {
    // This logic was commented out or misplaced. It should be inside an if(search) block.
    // We will build a more flexible query.
    const searchQuery = {
      $or: [
        { title: { $regex: search, $options: "i" } }, // Case-insensitive search for title
        { TaskId: search }, // Exact match for TaskId
      ],
    };

    // Combine the base filter with the search query
    // If filterQuery already has an $or (from creatorOrAssignorId), we must use $and.
    let finalQuery;
    if (filterQuery.$or) {
      finalQuery = { $and: [filterQuery, searchQuery] };
    } else {
      finalQuery = { ...filterQuery, ...searchQuery };
    }
    if (query.status !== "Upcoming") {
      finalQuery.isVisible = true;
    }
    // Get total count
    total = await Task.countDocuments(finalQuery);

    // Get paginated tasks
    const rawTasks = await Task.find(finalQuery)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .populate("departmentOfAssignToUser", "name")
      .populate("dependencyConfig.taskDependent", "title")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    tasks = rawTasks.map(normalizeTask);
  } else {
    // No search term
    const rawTasks = await Task.find(filterQuery)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .populate("departmentOfAssignToUser", "name")
      .populate("dependencyConfig.taskDependent", "title")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    tasks = rawTasks.map(normalizeTask);
    total = await Task.countDocuments(filterQuery);
  }

  res.status(200).json({
    success: true,
    data: tasks,
    totalTasks: total, // Send total tasks for pagination
    currentPage: parseInt(page),
    perPage: parseInt(limit),
    totalPages: Math.ceil(total / parseInt(limit)),
  });
});
// ---------------------------------------------------------
// GET BY ID
// ---------------------------------------------------------
export const getTaskById = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id))
    return next(new AppError("Invalid ID", 400));

  const task = await Task.findById(id)
    .populate("assignedTo", "name email")
    .populate("assignedBy", "name email")
    .populate("createdBy", "name email")
    .populate("updatedBy", "name email")
    .populate("dependencyConfig.taskDependent", "title TaskId");

  if (!task) return next(new AppError("Task not found", 404));
  // If task was just completed, update dependent children that use 'actual-to-planned'
  if (task.status === "Completed") {
    try {
      const parentCompletedAt = task.completedAt || new Date();

      // Find dependent children whose dependencyConfig.taskDependent is this task
      const children = await Task.find({
        "dependencyConfig.taskDependent": task._id,
      }).exec();

      for (const child of children) {
        const dep = child.dependencyConfig || {};
        const startSetting = (dep.startTimeSetting || "").toLowerCase();

        // Only update those configured as actual-to-planned (per request); leave others
        if (startSetting === "actual-to-planned") {
          // Compute child's new start based on parent's actual completion + X
          const x =
            dep.xValue !== null && dep.xValue !== undefined
              ? Number(dep.xValue)
              : 0;
          const freqStr = (dep.isDependentFrequency || "").toLowerCase();

          let newStart = new Date(parentCompletedAt);
          if (freqStr.includes("hour")) {
            newStart.setHours(newStart.getHours() + x);
          } else {
            newStart.setDate(newStart.getDate() + x);
          }

          // Determine duration (taskEndDays): prefer stored dep.taskEndDays, fallback to difference between existing dueDate and startDate
          let durationDays = null;
          if (dep.taskEndDays !== null && dep.taskEndDays !== undefined) {
            durationDays = Number(dep.taskEndDays);
          } else if (child.dueDate && child.startDate) {
            const ms =
              new Date(child.dueDate).getTime() -
              new Date(child.startDate).getTime();
            durationDays = Math.ceil(ms / (24 * 60 * 60 * 1000));
          }

          let newDue = null;
          if (durationDays !== null && !isNaN(durationDays)) {
            const addDays = Math.max(0, Number(durationDays) - 1); // off-by-one logic
            newDue = new Date(newStart);
            newDue.setDate(newDue.getDate() + addDays);
          }

          // Update child (only dates)
          const update = { startDate: newStart };
          if (newDue) update.dueDate = newDue;

          await Task.findByIdAndUpdate(child._id, update, { new: true }).exec();
        }
      }
    } catch (err) {
      console.error(
        "Failed to update dependent children on parent completion:",
        err,
      );
    }
  }

  res.status(200).json({
    success: true,
    data: normalizeTask(task),
  });
});
//**get task conversations */
export const getConversations = handleAsync(async (req, res) => {
  const { id } = req.params;

  const task = await Task.findById(id).populate({
    path: "conversationId",
    populate: {
      path: "participants",
      select: "name email",
    },
  });

  if (!task || !task.conversationId) {
    return res.status(404).json({
      success: false,
      message: "Task or conversation not found",
    });
  }

  // ✅ Fetch messages separately
  const messages = await Messages.find({
    conversationId: task.conversationId._id,
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate("sender", "name email");

  res.json({
    success: true,
    data: {
      conversation: task.conversationId,
      messages,
    },
  });
});
export const toggleTaskCompletion = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const { completeStatus } = req.body;

  // 🔥 1. GET OLD DATA FIRST
  const existingTask = await Task.findById(id);
  if (!existingTask) return next(new AppError("Task not found", 404));

  const oldData = existingTask.toObject();

  // 🔥 2. PREPARE UPDATE
  const updateData = {
    completeStatus,
    updatedBy: req.user._id,
  };

  if (completeStatus) {
    if (existingTask.checklist && existingTask.checklist.length > 0) {
      const allChecklistDone = existingTask.checklist.every(
        (item) => item?.isCompleted === true,
      );

      if (!allChecklistDone) {
        return res.status(400).json({
          success: false,
          message:
            "Please complete all checklist items before marking task complete",
        });
      }
    }

    updateData.status = "Completed";
    updateData.taskDoneBy = req.user._id;
    updateData.completedAt = new Date();
  } else {
    updateData.status = "Pending";
    updateData.taskDoneBy = null;
    updateData.completedAt = null;
  }

  // 🔥 3. UPDATE TASK
  const updatedTask = await Task.findByIdAndUpdate(id, updateData, {
    new: true,
  });

  const newData = updatedTask.toObject();

  // 🔥 4. SMART MESSAGE
  const message = completeStatus
    ? `✅ Task "${updatedTask.title}" marked as completed`
    : `↩️ Task "${updatedTask.title}" marked as pending`;

  // 🔥 5. CREATE LOG
  await createLog({
    action: "UPDATE",
    module: "TASK",
    documentId: updatedTask._id,
    performedBy: req.user._id, // ✅ FIX (don't use cookies)
    oldData,
    newData,
    message,
  });
  // =========================================================
  // ✅ ACTUAL-TO-PLANNED TRIGGER (CORRECT PLACE)
  // =========================================================

  const justCompleted = completeStatus === true && oldData.status !== true;

  if (justCompleted) {
    const dependentTasks = await Task.find({
      "dependencyConfig.taskDependent": updatedTask._id,
      "dependencyConfig.startTimeSetting": "actual-to-planned",
      waitingForParent: true,
    }).populate({
      path: "assignedTo",
      populate: { path: "assignShift" },
    });

    console.log("Dependent tasks found:", dependentTasks.length);

    for (const depTask of dependentTasks) {
      try {
        const workShift = depTask.assignedTo.assignShift;
        if (!workShift) continue;

        const x = Number(depTask.dependencyConfig.xValue || 0);
        const freqStr = (
          depTask.dependencyConfig.isDependentFrequency || ""
        ).toLowerCase();

        // 🔹 Step 1: Base date = parent dueDate (or completedAt) → only DATE part
        let baseDate = updatedTask.dueDate
          ? new Date(updatedTask.dueDate)
          : updatedTask.completedAt
            ? new Date(updatedTask.completedAt)
            : new Date();
        baseDate.setHours(0, 0, 0, 0);

        // 🔹 Step 2: Compute child start date based on hours or days
        let childStart;
        if (freqStr.includes("hour")) {
          // Hour-based: shift start + X hours
          const shiftStart = await nextWorkingShiftDate(
            baseDate,
            workShift._id,
          );
          childStart = new Date(shiftStart);
          childStart.setHours(childStart.getHours() + x);
        } else {
          // Day-based: add X working days → shift start of that day
          childStart = await addWorkingDaysHoliday(baseDate, x, workShift._id);
        }

        // 🔹 Step 3: Compute child due date if taskEndDays exist
        let childDue = null;
        const taskDays = Number(depTask.taskEndDays || 0);
        if (!isNaN(taskDays) && taskDays > 0) {
          childDue = await addWorkingDaysHoliday(
            childStart,
            taskDays,
            workShift._id,
          );
        }

        // 🔹 Step 4: Update child task
        const childTask = await Task.findById(depTask._id);
        if (childTask) {
          childTask.startDate = childStart;
          childTask.dueDate = childDue;
          childTask.waitingForParent = false;
          childTask.updatedAt = new Date();
          await childTask.save();
          console.log(
            `✅ Updated child ${depTask.TaskId}: start=${childStart}, due=${childDue}`,
          );
        }
      } catch (err) {
        console.error("❌ Error updating child task:", err);
      }
    }
  }
  // 🔥 6. RESPONSE
  res.status(200).json({
    success: true,
    data: normalizeTask(updatedTask),
  });
});
// ---------------------------------------------------------
// DELETE
// ---------------------------------------------------------
export const deleteTask = handleAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id))
    return next(new AppError("Invalid ID", 400));

  try {
    const task = await Task.findById({ _id: id });
    if (!task) {
      return next(new AppError("Task not found", 404));
    }

    // Delete task
    await Task.deleteOne({ _id: id });

    // Save history
    const historyDoc = await DeleteTaskHistory.create({
      deleteParentTaskId: null,
      deletedBy: req.cookies.userId || req.user._id || null,
      remark: "",
      deletedTasksCount: 1,
      deletedTaskIds: [task._id],
    });

    res.status(200).json({
      success: true,
      message: "Task deleted",
      deletedCount: 1,
      deletedTaskIds: [task._id],
      historyId: historyDoc._id,
    });
  } catch (err) {
    return next(err);
  }
});
// export const deleteTask = handleAsync(async (req, res, next) => {
//   const { id } = req.params;

//   if (!mongoose.Types.ObjectId.isValid(id))
//     return next(new AppError("Invalid ID", 400));

//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const task = await Task.findById(id).session(session);
//     if (!task) {
//       await session.abortTransaction();
//       session.endSession();
//       return next(new AppError("Task not found", 404));
//     }

//     // Delete the single task
//     await Task.deleteOne({ _id: id }).session(session);

//     // Record delete history for audit
//     // For a single (non-dependent) task delete, we do not set a parent task id
//     const historyDocs = await DeleteTaskHistory.create(
//       [
//         {
//           deleteParentTaskId: null,
//           deletedBy: req.user && req.user._id ? req.user._id : null,
//           remark: "",
//           deletedTasksCount: 1,
//           deletedTaskIds: [task._id],
//         },
//       ],
//       { session },
//     );

//     await session.commitTransaction();
//     session.endSession();

//     res.status(200).json({
//       success: true,
//       message: "Task deleted",
//       deletedCount: 1,
//       deletedTaskIds: [task._id],
//       historyId: historyDocs && historyDocs[0] ? historyDocs[0]._id : null,
//     });
//   } catch (err) {
//     await session.abortTransaction();
//     session.endSession();
//     return next(err);
//   }
// });

// Delete parent task and all dependent child tasks (recursive), record history
export const deleteParentAndChildren = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const { remark } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(id))
    return next(new AppError("Invalid ID", 400));

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const parent = await Task.findById(id).session(session);
    if (!parent) {
      await session.abortTransaction();
      session.endSession();
      return next(new AppError("Task not found", 404));
    }

    // Collect all tasks to delete: parent + all tasks that (directly or indirectly) depend on it
    const toDeleteIds = [parent._id];
    let queue = [parent._id];

    while (queue.length > 0) {
      const children = await Task.find({
        "dependencyConfig.taskDependent": { $in: queue },
      })
        .session(session)
        .select("_id");
      if (!children || children.length === 0) break;
      const childIds = children.map((c) => c._id);
      // Filter new ones
      const newIds = childIds.filter(
        (cid) => !toDeleteIds.some((existing) => existing.equals(cid)),
      );
      if (newIds.length === 0) break;
      toDeleteIds.push(...newIds);
      queue = newIds;
    }

    // Delete tasks
    const deleteResult = await Task.deleteMany({
      _id: { $in: toDeleteIds },
    }).session(session);

    // Record delete history
    const historyDocs = await DeleteTaskHistory.create(
      [
        {
          deleteParentTaskId: parent.TaskId || parent._id.toString(),
          deletedBy: req.user && req.user._id ? req.user._id : null,
          remark: remark || "",
          deletedTasksCount: toDeleteIds.length,
          deletedTaskIds: toDeleteIds,
        },
      ],
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: `Parent task and ${toDeleteIds.length - 1} dependent task(s) deleted`,
      deletedCount: toDeleteIds.length,
      deletedTaskIds: toDeleteIds,
      historyId: historyDocs && historyDocs[0] ? historyDocs[0]._id : null,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
});

// ---------------------------------------------------------
// HELPER: Normalize Response
// ---------------------------------------------------------
function normalizeTask(task) {
  if (!task) return null;
  const obj =
    typeof task.toObject === "function" ? task.toObject() : { ...task };
  const dep = obj.dependencyConfig || {};

  return {
    ...obj,
    id: obj._id,
    taskId: obj.TaskId,
    asignBy: obj.assignedBy,
    parentTask: dep.taskDependent,
    startTimeSetting: dep.startTimeSetting,
    isDependentFrequency: dep.isDependentFrequency,
    xValue: dep.xValue,
    taskEndDays: obj.taskEndDays ?? null,
    taskType:
      obj.taskType || (obj.frequency ? "RecurringTask" : "DelegationTask"),
  };
}
export const downloadAttachment = handleAsync(async (req, res, next) => {
  const { filePath } = req.query;

  if (!filePath) {
    return next(new AppError("File path is required", 400));
  }

  if (filePath.includes("..")) {
    return next(new AppError("Invalid file path", 400));
  }

  const fullPath = path.join(process.cwd(), "uploads", filePath);

  if (!fs.existsSync(fullPath)) {
    return next(new AppError("File not found", 404));
  }

  res.sendFile(fullPath);
});
// export const downloadAttachment = handleAsync(async (req, res, next) => {
//   const { filename } = req.params;

//   // Basic security: prevent directory traversal
//   if (filename.includes("..")) {
//     return next(new AppError("Invalid filename", 400));
//   }

//   const filePath = path.join(process.cwd(), "uploads", filename);

//   // Check if file exists
//   if (fs.existsSync(filePath)) {
//     res.download(filePath, filename, (err) => {
//       if (err) {
//         // Handle error, but don't expose file system details.
//         // The 'next(err)' will be caught by the generic error handler.
//         console.error("File download error:", err);
//         if (!res.headersSent) {
//           return next(new AppError("Could not download the file.", 500));
//         }
//       }
//     });
//   } else {
//     return next(new AppError("File not found.", 404));
//   }
// });

export const uploadAttachment = handleAsync(async (req, res, next) => {
  if (!req.files || req.files.length === 0) {
    return next(new AppError("No files uploaded.", 400));
  }

  const filenames = req.files.map((file) => file.filename);

  res.status(200).json({
    success: true,
    message: "Files uploaded successfully",
    data: { filenames: filenames },
  });
});
const parseFlexibleDate = (dateStr) => {
  if (!dateStr) return null;

  const parts = dateStr.split(/[-/]/).map((p) => parseInt(p, 10));

  if (parts.length !== 3) return null;

  let day, month, year;

  // YYYY-MM-DD
  if (parts[0] > 1000) {
    [year, month, day] = parts;
  }
  // DD-MM-YYYY OR MM-DD-YYYY
  else {
    const [p1, p2, p3] = parts;

    year = p3;

    // If second value > 12 → it's DD-MM
    if (p2 > 12) {
      day = p2;
      month = p1;
    }
    // If first value > 12 → it's DD-MM
    else if (p1 > 12) {
      day = p1;
      month = p2;
    }
    // Ambiguous (like 05-06-2024)
    else {
      // 👉 Default assume DD-MM-YYYY (recommended for India)
      day = p1;
      month = p2;
    }
  }

  const date = new Date(year, month - 1, day);

  return isNaN(date.getTime()) ? null : date;
};
export const importTasks = handleAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("No file uploaded.", 400));
  }

  const filePath = req.file.path;
  const errors = [];
  const validTasks = [];
  let rows = [];
  let rowCount = 0;

  try {
    // --- 1. Parse File (CSV or XLSX) ---
    if (
      req.file.mimetype === "text/csv" ||
      req.file.originalname.toLowerCase().endsWith(".csv")
    ) {
      rows = await new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
          .pipe(csv())
          .on("data", (data) => results.push(data))
          .on("end", () => resolve(results))
          .on("error", (error) => reject(error));
      });
    } else {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    }

    if (rows.length === 0) {
      fs.unlinkSync(filePath);
      return next(
        new AppError(
          "The uploaded file is empty or in an unsupported format.",
          400,
        ),
      );
    }

    // --- Header Validation: enforce required headers per detected template and flag mistyped names ---
    const headers = Object.keys(rows[0] || {}).map((h) => String(h).trim());
    const normalize = (s) =>
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    const normalized = headers.map(normalize);
    // Define required headers for each template (normalized)
    const required = {
      delegation: [
        "tasktitle",
        "taskdescription",
        "assigntoemail",
        "assigntouserdepartment",
        "startdate",
        "taskenddays",
      ],
      recurring: [
        "tasktitle",
        "taskdescription",
        "assigntoemail",
        "assigntouserdepartment",
        "startdate",
        "frequency",
        "enddate",
      ],
      dependent: [
        "taskid",
        "tasktitle",
        "taskdescription",
        "assigntoemail",
        "assigntouserdepartment",
        "starttimesetting",
        "frequency",
        "xvalue",
      ],
    };

    // Detect template from headers: dependent if Task ID present; recurring if Frequency+End Date; else delegation
    let detected = "delegation";
    if (normalized.includes("taskid")) detected = "dependent";
    else if (normalized.includes("frequency") && normalized.includes("enddate"))
      detected = "recurring";

    // Check for missing required headers for detected template
    const missing = required[detected].filter((h) => !normalized.includes(h));
    if (missing.length > 0) {
      // Find any suspect headers that look similar to missing ones (basic substring match)
      const suspects = headers.filter((h) =>
        missing.some(
          (m) =>
            h.toLowerCase().includes(m.replace(/([a-z])([A-Z])/g, "$1 $2")) ||
            m.includes(h.toLowerCase().replace(/[^a-z0-9]/g, "")),
        ),
      );
      return next(
        new AppError(
          `Missing required column(s) for ${detected} import: ${missing.join(", ")}. Please use the exact header names.${suspects.length ? " Suspect headers: " + suspects.join(", ") : ""}`,
          400,
        ),
      );
    }

    // Additionally, detect common misspellings for optional columns like "Check List" and complain
    const checklistNormalized = "checklist";
    if (!normalized.includes(checklistNormalized)) {
      const suspectHeaders = headers.filter((h) => /check|list/i.test(h));
      if (suspectHeaders.length > 0) {
        return next(
          new AppError(
            `Invalid column name(s): ${suspectHeaders.join(", ")}. Did you mean "Check List"? Please use the exact header name.`,
            400,
          ),
        );
      }
    }

    // --- 2. Process each row ---
    for (const row of rows) {
      rowCount++;
      const originalRow = { ...row }; // Keep original for error reporting

      try {
        // --- 3. Validation ---
        const {
          "Task Title": title,
          "Task Description": description,
          "Assign To(Email)": assignToEmail, // Assuming email is used for lookup
          "Assign To(Name)": assignToName, // New: Assuming name is also used for lookup and validation
          "Assign To UserDepartment": departmentName,
          "Start Date": startDateStr,
          "Due Date": dueDateStr,
          "Task End Days": taskEndDaysStr,
          isDependent: isDependentStr,
          "Attachment File": attachmentFile,
          "Check List": checkListStr, // Added checklist
          // Fields for different task types
          Frequency: frequency,
          "Task ID": parentTaskId,
          "Start Time Setting": startTimeSetting,
          "X Value": xValue,
          "End Date": endDateStr,
          "Week Days": weekDaysStr,
        } = row;
        // Trim whitespace from string fields
        const trimmedStartDateStr = startDateStr
          ? String(startDateStr).trim()
          : "";
        const trimmedTaskEndDays = taskEndDaysStr
          ? String(taskEndDaysStr).trim()
          : "";
        const trimmedDueDateStr = dueDateStr ? String(dueDateStr).trim() : "";
        const trimmedEndDateStr = endDateStr ? String(endDateStr).trim() : "";
        const trimmedIsDependentStr = isDependentStr
          ? String(isDependentStr).trim()
          : "";
        const trimmedParentTaskId = parentTaskId
          ? String(parentTaskId).trim()
          : "";
        const trimmedStartTimeSetting = startTimeSetting
          ? String(startTimeSetting).trim()
          : "";
        const trimmedXValue = xValue ? String(xValue).trim() : "";
        const trimmedFrequency = frequency ? String(frequency).trim() : "";
        const trimmedAttachmentFile = attachmentFile
          ? String(attachmentFile).trim()
          : "";
        const trimmedCheckListStr = checkListStr
          ? String(checkListStr).trim()
          : "";
        const weekDaysArr = weekDaysStr
          ? weekDaysStr
              .split(",")
              .map((day) => day.trim().toLowerCase())
              .filter(Boolean)
          : [];
        // Basic required fields
        if (!title || !description || !assignToEmail || !departmentName) {
          throw new Error(
            "Missing one or more required fields: Task Title, Task Description, Assign To(Email), Assign To UserDepartment.",
          );
        }

        // Split assignToEmail and assignToName if they are comma-separated
        const assignToEmails = assignToEmail
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
        const assignToNames = assignToName
          ? assignToName
              .split(",")
              .map((n) => n.trim())
              .filter(Boolean)
          : [];

        if (assignToEmails.length === 0) {
          throw new Error('At least one "Assign To(Email)" is required.');
        }
        if (
          assignToNames.length > 0 &&
          assignToNames.length !== assignToEmails.length
        ) {
          throw new Error(
            'Mismatched count for "Assign To(Email)" and "Assign To(Name)". If "Assign To(Name)" is provided, it must match the number of emails.',
          );
        }

        const department = await Department.findOne({
          name: { $regex: `^${departmentName}$`, $options: "i" },
        });
        if (!department) {
          throw new Error(
            `Department with name "${departmentName}" not found.`,
          );
        }

        const usersForThisRow = [];
        for (let i = 0; i < assignToEmails.length; i++) {
          const currentEmail = assignToEmails[i];
          const currentName = assignToNames[i];

          const userQuery = { email: currentEmail };
          if (currentName) {
            userQuery.name = currentName;
          }
          const user = await User.findOne(userQuery);
          if (!user) {
            throw new Error(
              `User with email "${currentEmail}" and name "${currentName || "N/A"}" not found.`,
            );
          }
          // Validate user belongs to the specified department
          if (
            !user.department ||
            user.department.length === 0 ||
            !user.department.some((deptId) => deptId.equals(department._id))
          ) {
            throw new Error(
              `User "${currentEmail}" does not belong to the "${departmentName}" department.`,
            );
          }
          usersForThisRow.push(user);
        }

        // Derive isDependent: explicit column OR presence of parent Task ID
        const isDependent =
          (trimmedIsDependentStr &&
            trimmedIsDependentStr.toLowerCase() === "true") ||
          Boolean(trimmedParentTaskId);

        // Date Validation
        // const startDate = trimmedStartDateStr
        //   ? parseDateIST(trimmedStartDateStr)
        //   : null;
        // const dueDate = trimmedDueDateStr
        //   ? parseDateIST(trimmedDueDateStr)
        //   : null;
        let startDate = trimmedStartDateStr
          ? parseFlexibleDate(trimmedStartDateStr)
          : null;

        let dueDate = trimmedDueDateStr
          ? parseFlexibleDate(trimmedDueDateStr)
          : null;
        let endDate = trimmedEndDateStr
          ? parseFlexibleDate(trimmedEndDateStr)
          : null;
        const taskEndDays = trimmedTaskEndDays
          ? Number(trimmedTaskEndDays)
          : null;
        // let dueDate = null;

        if (startDate && taskEndDays) {
          dueDate = new Date(startDate);
          dueDate.setDate(dueDate.getDate() + Number(taskEndDays));
        }
        const isRecurrent = detected === "recurring"; // ⚠️ also fix spelling

        if (!isDependent && !isRecurrent) {
          if (!taskEndDays || isNaN(taskEndDays)) {
            throw new Error(
              "Task End Days must be a valid number for delegation tasks.",
            );
          }
        }
        // For non-dependent tasks, start date is required and must be valid
        if (!isDependent && !startDate) {
          throw new Error(
            "Start Date is required for delegation and recurring tasks. Please use DD-MM-YYYY or YYYY-MM-DD format.",
          );
        }
        // For dependent tasks, start date is optional; only validate when provided
        if (isDependent && trimmedStartDateStr && !startDate) {
          throw new Error(
            "Invalid Start Date format. Please use DD-MM-YYYY or YYYY-MM-DD.",
          );
        }
        if (trimmedDueDateStr && !dueDate) {
          throw new Error(
            "Invalid Due Date format. Please use DD-MM-YYYY or YYYY-MM-DD.",
          );
        }

        // Normalize and validate dependent task Frequency (if row is dependent)
        let depFreqNormalized = null;
        if (isDependent) {
          if (!trimmedFrequency) {
            throw new Error(
              'Frequency is required for dependent tasks. Allowed values: "T+X in days" or "T+X in hours".',
            );
          }
          const f = trimmedFrequency.toLowerCase();
          if (/t\+x\s*.*days|t\+xdays/i.test(f)) {
            depFreqNormalized = "T+X in days";
          } else if (/t\+x\s*.*hours|t-?x\s*.*hours|t\+xhours/i.test(f)) {
            // Map common hour variants to the stored value
            depFreqNormalized = "T-X in hours";
          } else {
            throw new Error(
              `Invalid Frequency "${trimmedFrequency}" for dependent task. Allowed: "T+X in days" or "T+X in hours".`,
            );
          }
        }

        // Attachment Check (remains outside the user loop as it's per row, not per user)
        let finalAttachmentPath = null;
        if (attachmentFile) {
          const attachmentPath = path.join(
            process.cwd(),
            "uploads",
            attachmentFile,
          );
          if (!fs.existsSync(attachmentPath)) {
            throw new Error(
              `Attachment file "${attachmentFile}" not found in the uploads directory.`,
            );
          }
          finalAttachmentPath = attachmentFile;
        }

        const checklist = checkListStr
          ? checkListStr.split(",").map((item) => ({ text: item.trim() }))
          : [];

        for (const user of usersForThisRow) {
          // <--- NEW LOOP
          // Duplicate Check: Same title, same user, same start day
          if (startDate) {
            const existingTask = await Task.findOne({
              title,
              assignedTo: user._id, // <--- Now uses current user from loop
              // Using gte and lt to check for the same day regardless of time
              startDate: {
                $gte: startOfDay(startDate),
                $lt: startOfDay(
                  new Date(startDate.getTime() + 24 * 60 * 60 * 1000),
                ),
              },
            });
            if (existingTask) {
              throw new Error(
                `A task with the same title for user ${user.email} on the same start date already exists.`,
              );
            }
          }
          // --- 4. Prepare Task Data ---
          const taskData = {
            title: title.trim(),
            description: description.trim(),
            assignedTo: user._id, // <--- Now uses current user from loop
            assignedBy: req.user._id,
            createdBy: req.user._id,
            startDate,
            dueDate,
            taskEndDays,
            attachmentFile: finalAttachmentPath,
            isDependent,
            departmentOfAssignToUser: department._id, // <--- Department is now from the single lookup
            checklist,
          };

          let taskInstance;

          // Delegation vs Recurring vs Dependent
          if (isDependent) {
            const parentTask = await Task.findOne({
              TaskId: trimmedParentTaskId,
            });

            if (!parentTask) {
              throw new Error(
                `Parent task with ID "${trimmedParentTaskId}" not found.`,
              );
            }
            const parentEnd =
              parentTask.dueDate || parentTask.endDate || parentTask.startDate;

            if (!parentEnd) {
              throw new Error("Parent task has no valid date.");
            }

            const x = Number(trimmedXValue) || 0;
            const freq = (trimmedFrequency || "").toLowerCase();

            let calculatedStartDate = new Date(parentEnd);

            // ✅ Handle T+X
            if (freq.includes("hour")) {
              calculatedStartDate.setHours(calculatedStartDate.getHours() + x);
            } else {
              calculatedStartDate.setDate(calculatedStartDate.getDate() + x);
            }

            // ✅ Override startDate
            startDate = calculatedStartDate;

            // ✅ Now calculate dueDate using taskEndDays
            if (taskEndDays && !isNaN(taskEndDays)) {
              dueDate = new Date(startDate);
              dueDate.setDate(dueDate.getDate() + Number(taskEndDays));
            }

            // Duplicate check (keep yours)
            const existingDependent = await Task.findOne({
              title: title.trim(),
              assignedTo: user._id,
              "dependencyConfig.taskDependent": parentTask._id,
            });

            if (existingDependent) {
              throw new Error(
                `A dependent task with the same title for user ${user.email} linked to parent ${trimmedParentTaskId} already exists.`,
              );
            }

            taskInstance = new DelegationTask({
              ...taskData,
              startDate,
              dueDate,
              dependencyConfig: {
                taskDependent: parentTask._id,
                startTimeSetting:
                  trimmedStartTimeSetting === "Planned to Planned"
                    ? "planned-to-planned"
                    : "actual-to-planned",
                isDependentFrequency: depFreqNormalized,
                xValue: x,
              },
            });
          } else if (trimmedFrequency) {
            // Recurring Task
            taskInstance = new RecurringTask({
              ...taskData,
              endDate,
              weekDays: weekDaysArr,
              frequency: trimmedFrequency, // e.g., 'Daily', 'Weekly'
              // endDate will be handled by recurring logic if needed
            });
          } else {
            // Simple Delegation Task
            // Allow delegation tasks without a dueDate (no strict server-side requirement).
            taskInstance = new DelegationTask(taskData);
          }

          // Manually generate TaskId for each task before bulk insert
          // Generate period-based counter (YYMM) so TaskId becomes YYMM####
          const now = new Date();
          const yy = String(now.getFullYear()).slice(-2);
          const mm = String(now.getMonth() + 1).padStart(2, "0");
          const period = `${yy}${mm}`;
          const counter = await Counter.findByIdAndUpdate(
            { _id: `taskId-${period}` },
            { $inc: { seq: 1 } },
            { new: true, upsert: true },
          );
          taskInstance.TaskId = `${period}${counter.seq.toString().padStart(4, "0")}`;

          validTasks.push(taskInstance);
        } // <--- END NEW LOOP
      } catch (error) {
        originalRow["Error"] = `Row ${rowCount}: ${error.message}`;
        errors.push(originalRow);
      }
    }

    // --- 5. Finalize ---
    if (errors.length > 0) {
      // Create error report
      const parser = new Parser({ fields: [...Object.keys(errors[0])] });
      const csv = parser.parse(errors);
      const errorFileName = `${Date.now()}-import-errors.csv`;
      const errorFilePath = path.join(process.cwd(), "uploads", errorFileName);
      fs.writeFileSync(errorFilePath, csv);

      // Send error response
      return res.status(422).json({
        success: false,
        message: `Import failed. ${errors.length} of ${rows.length} rows have errors.`,
        errorFile: errorFileName, // Only return the filename
      });
    } else {
      // Save all valid tasks to DB
      await Task.insertMany(validTasks);
      res.status(201).json({
        success: true,
        message: `Successfully imported ${validTasks.length} tasks.`,
      });
    }
  } catch (err) {
    // Catch any top-level errors (e.g., file read failure)
    return next(new AppError(err.message, 500));
  } finally {
    // --- 6. Cleanup ---
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error deleting uploaded file ${filePath}:`, err);
    });
  }
});

// ---------------------------------------------------------
// FINAL MERGED UPDATE TASK CONTROLLER
// ---------------------------------------------------------
// Simple checklist toggle - only updates single item true/false
export const updateChecklistItem = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const { index, completed } = req.body;

  const idx = parseInt(index);
  if (isNaN(idx) || idx < 0) {
    return next(new AppError("Invalid checklist index", 400));
  }
  const isCompleted = completed === true || completed === "true";

  const task = await Task.findById(id);
  if (!task) {
    return next(new AppError("Task not found", 404));
  }

  if (
    !task.checklist ||
    !Array.isArray(task.checklist) ||
    task.checklist.length <= idx
  ) {
    return next(new AppError("Invalid checklist index", 400));
  }

  const oldData = task.toObject();

  task.checklist[idx].isCompleted = isCompleted;
  task.updatedBy = req.user._id;
  task.updatedAt = new Date();

  const updatedTask = await task.save();

  await createLog({
    action: "UPDATE_CHECKLIST",
    module: "TASK",
    documentId: task._id,
    performedBy: req.user._id,
    oldData,
    newData: updatedTask,
    message: `Checklist item ${idx} updated to ${isCompleted ? "completed" : "pending"} | Task: ${task.title}`,
  });

  const progress =
    task.checklist.length > 0
      ? Math.round(
          (task.checklist.filter((item) => item.isCompleted).length /
            task.checklist.length) *
            100,
        )
      : 100;

  res.status(200).json({
    success: true,
    message: `Checklist item ${idx} updated`,
    data: {
      checklist: task.checklist,
      progress: `${progress}%`,
      taskId: task.TaskId,
    },
  });
});
export const updateTask = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  let shouldRecalculateStatus = false;
  // 1. Fetch the document first
  const task = await Task.findById(id);
  const oldData = task.toObject();
  if (!task) {
    return next(new AppError("Task not found", 404));
  }

  // 2. Destructure Body (Capture 'status' separately for the trigger)
  const {
    isRecurrent,
    parentTask,
    startTimeSetting,
    isDependentFrequency,
    xValue,
    assignedTo,
    checklist,
    startDate,
    dueDate,
    frequency,
    endDate,
    weekDays,
    status,
    taskEndDays, // <--- We capture this explicitly to check later
    ...otherUpdates
  } = req.body;

  // 3. Apply general updates
  Object.assign(task, otherUpdates);

  // Apply Status if present (Manually applied to ensure we track the change)
  if (status) {
    task.status = status;
  }

  // 4. Handle specific fields (File, User, Checklists)
  if (assignedTo) task.assignedTo = assignedTo;
  // if (req.file) task.attachmentFile = req.file.filename;

  // if (req.file)
  //   task.attachmentFile = req.files.map(
  //     (file) => `${req.uploadFolder}/${file.filename}`,
  //   );
  // ================= FILE HANDLING =================
  let existingFiles = [];
  let removedFiles = [];

  try {
    existingFiles = JSON.parse(req.body.existingFiles || "[]");
    removedFiles = JSON.parse(req.body.removedFiles || "[]");
  } catch (err) {
    console.error("Error parsing file arrays:", err);
  }

  // 🧹 Delete removed files
  removedFiles.forEach((filePath) => {
    const fullPath = path.join(process.cwd(), "uploads", filePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  });

  // 📁 New uploaded files
  const newFiles = req.files
    ? req.files.map((file) => `${req.uploadFolder}/${file.filename}`)
    : [];
  // 🔗 Merge
  task.attachmentFile = [...existingFiles, ...newFiles];
  task.updatedBy = req.user._id;

  if (otherUpdates.isDependent !== undefined) {
    task.isDependent =
      otherUpdates.isDependent === "true" || otherUpdates.isDependent === true;
  }

  // Handle checklist update (Your original robust logic)
  if (checklist !== undefined) {
    try {
      if (checklist) {
        task.checklist =
          typeof checklist === "string" ? JSON.parse(checklist) : checklist;
      } else {
        task.checklist = [];
      }
    } catch (e) {
      console.error("Failed to parse checklist on update", e);
    }
  }

  // Handle date updates (Your original parsing logic)
  if (startDate !== undefined) {
    task.startDate = cleanField(startDate) ? parseDateIST(startDate) : null;
    shouldRecalculateStatus = true;
  }
  if (dueDate !== undefined) {
    task.dueDate = cleanField(dueDate) ? parseDateIST(dueDate) : null;
    shouldRecalculateStatus = true;
  }
  let effectiveStartDate = cleanField(startDate)
    ? parseDateIST(startDate)
    : null;
  if (taskEndDays !== null && taskEndDays > 0 && task.assignedTo) {
    task.taskEndDays = Number(taskEndDays);
    const user = await User.findById(task.assignedTo).populate("assignShift");
    if (user?.assignShift) {
      const workShiftId = user.assignShift._id;
      task.dueDate = await addWorkingDaysHoliday(
        effectiveStartDate,
        Number(taskEndDays),
        workShiftId,
      );
    }
  }

  // 5. Handle discriminator-specific fields (RecurringTask)
  if (task.taskType === "RecurringTask") {
    if (frequency !== undefined) task.frequency = cleanField(frequency);
    if (endDate !== undefined)
      task.endDate = cleanField(endDate) ? parseDateIST(endDate) : null;

    // Your original robust weekDays logic
    if (weekDays !== undefined) {
      try {
        if (typeof weekDays === "string" && weekDays.trim().startsWith("[")) {
          task.weekDays = JSON.parse(weekDays);
        } else if (Array.isArray(weekDays)) {
          task.weekDays = weekDays;
        } else if (weekDays === null || weekDays === "") {
          task.weekDays = [];
        }
      } catch (e) {
        console.error("Failed to parse weekDays on update", e);
      }
    }
  }
  if (shouldRecalculateStatus && task.status !== "Completed") {
    task.status = calculateStatus(task);
  }
  if (status === "Completed") {
    task.completedAt = new Date();
  } else if (status && status !== "Completed") {
    task.completedAt = null;
  }
  // 6. SAVE THE TASK (Parent/Current Task)
  const updatedTask = await task.save();
  // 🔌 Socket.IO: Task Update Notification
  // const io = getIO();
  // if ( req.cookies.userId.toString() !== task.assignedTo.toString()) {
  //   await Notifications.create({
  //     user: task.assignedTo,
  //     type: "TASK_UPDATE",
  //     title: `Task Updated: ${task.title}`,
  //     description: `Task ${task.TaskId} status: ${task.status}`,
  //     relatedId: task._id,
  //   });
  //   io.to(task.assignedTo.toString()).emit("task-updated", {
  //     taskId: task._id,
  //     status: task.status,
  //     conversationId: task.conversationId,
  //   });
  // }

  await createLog({
    action: "UPDATE",
    module: "TASK",
    documentId: task._id,
    performedBy: req.cookies.userId || req.user._id || null,
    oldData,
    newData: task,
    message: `Task Updated | Title: ${task.title} | ID: ${task.TaskId}`,
  });
  // =========================================================
  // ✅ ACTUAL-TO-PLANNED FIX (FINAL)
  // =========================================================

  // ✅ Trigger ONLY when task just completed
  const justCompleted =
    status === "Completed" && oldData.status !== "Completed";

  if (justCompleted) {
    const dependentTasks = await Task.find({
      "dependencyConfig.taskDependent": task._id,
      "dependencyConfig.startTimeSetting": "actual-to-planned",
      waitingForParent: true, // ✅ VERY IMPORTANT
    }).populate({
      path: "assignedTo",
      populate: { path: "assignShift" },
    });

    for (const depTask of dependentTasks) {
      try {
        const workShift = depTask.assignedTo.assignShift;

        const x = Number(depTask.dependencyConfig.xValue || 0);
        const freq = (
          depTask.dependencyConfig.isDependentFrequency || ""
        ).toLowerCase();

        // ✅ Use ACTUAL completion time
        let baseDate = new Date(task.completedAt);

        let newStartDate;

        // ✅ HANDLE HOURS
        if (freq.includes("hour")) {
          baseDate.setHours(baseDate.getHours() + x);

          newStartDate = await nextWorkingShiftDate(baseDate, workShift._id);
        }
        // ✅ HANDLE DAYS (WITH HOLIDAY + SHIFT)
        else {
          newStartDate = await addWorkingDaysHoliday(
            baseDate,
            x,
            workShift._id,
          );
        }

        let newDueDate = null;

        // ✅ HANDLE DUE DATE BASED ON CHILD CONFIG
        // if (depTask.taskEndDays) {
        //   newDueDate = await addWorkingDaysHoliday(
        //     newStartDate,
        //     depTask.taskEndDays,
        //     workShift._id,
        //   );
        // }

        // // ✅ UPDATE CHILD TASK
        // await Task.findByIdAndUpdate(depTask._id, {
        //   startDate: newStartDate,
        //   dueDate: newDueDate,
        //   waitingForParent: false, // ✅ unlock
        //   updatedAt: new Date(),
        // });

        const taskDays = Number(depTask.taskEndDays);

        if (!isNaN(taskDays) && taskDays > 0) {
          // ✅ FIXED
          newDueDate = await addWorkingDaysHoliday(
            newStartDate,
            taskDays,
            workShift._id,
          );
          console.log(`✅ Due: ${newDueDate}`);
        } else {
          console.log(`⚠️ Skip dueDate: invalid taskEndDays (${taskDays})`);
        }

        // ✅ FIXED: Use populate + direct save for discriminator
        const childTask = await Task.findById(depTask._id).populate(
          "assignedTo",
        );
        if (childTask) {
          childTask.startDate = newStartDate;
          childTask.dueDate = newDueDate;
          childTask.waitingForParent = false;
          childTask.updatedAt = new Date();
          await childTask.save();
          console.log(
            `✅ SAVED child ${depTask.TaskId}: dueDate=${newDueDate}`,
          );
        }
      } catch (err) {
        console.error("❌ Error updating child task:", err);
      }
    }
  }
  // =========================================================

  // 7. Populate and Respond
  await updatedTask.populate("assignedTo");

  res.status(200).json({
    success: true,
    data: normalizeTask(updatedTask),
  });
});
