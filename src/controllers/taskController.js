import { Task, DelegationTask, RecurringTask } from "../models/Task.js";
import {
  isSameDay,
  isAfter,
  startOfDay,
  endOfDay,
  parseISO,
  format,
  addDays,
  addWeeks,
} from "date-fns";
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
  isHoliday,
  snapToShiftTime,
} from "../utils/dateCalculator.js";
import { createLog } from "./logController.js";
import ScheduleHolidayTask from "../models/ScheduleHolidayTask.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import Conversation from "../models/queries/Conversation.js";
import Notifications from "../models/queries/Notification.js";
import { getIO } from "../socket.js";
import * as threadController from "./queries/thread.js";
import Messages from "../models/queries/Message.js";
import ModuleSetting from "../models/ModuleSetting.js";
import WorkShift from "../models/WorkShift.js";
import TaskDelegationFlow from "../models/TaskDelegationFlow.js";
import Conversations from "../models/queries/Conversation.js";
import { taskReopenedEmail } from "../services/templates/reopenTaskTemplate.js";
import sendEmail from "../services/emailService.js";
import { taskCompletedTemplate } from "../services/templates/taskCompleteTemp.js";
import TaskBucket from "../models/TaskBucket.js";
import { generateRecurringTasks } from "../cron/assignRecurringTask.js";
import { taskAssignedTemplate } from "../services/templates/taskAssignedTemp.js";
import { sendNotification } from "../services/telegram/services/taskTelegramService.js";
import FmsInstance from "../models/FmsInstance.js";

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
    const ddMMyyyyMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);

    if (ddMMyyyyMatch) {
      const [, day, month, year] = ddMMyyyyMatch;

      return new Date(Number(year), Number(month) - 1, Number(day));
    }

    const yyyyMMddMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (yyyyMMddMatch) {
      const [, year, month, day] = yyyyMMddMatch;

      return new Date(Number(year), Number(month) - 1, Number(day));
    }
  }

  const parsed = new Date(dateStr);

  return isNaN(parsed.getTime()) ? null : parsed;
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
    //    return start.getDate() === date && [1, 4, 7, 10].includes(month);
    case "Quarterly": {
      const startMonth = start.getMonth() + 1;

      const monthDiff =
        (today.getFullYear() - start.getFullYear()) * 12 + (month - startMonth);

      return monthDiff >= 0 && monthDiff % 3 === 0 && start.getDate() === date;
    }
    // case "Half Yearly":
    //    return start.getDate() === date && [1, 7].includes(month);

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
    weekStartDay,
    repeatAfter,
    taskEndTime,
    // delegationFlowEnabled,
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

    // 🔥 COMPUTE EFFECTIVE DATES (WORKSHIFT AWARE & DEPARTMENT LINKED)
    let effectiveStartDate = parsedStartDate
      ? await nextWorkingShiftDate(parsedStartDate, workShift._id, {}, deptId)
      : await nextWorkingShiftDate(new Date(), workShift._id, {}, deptId);

    let effectiveDueDate = null;
    if (parsedTaskEndDays !== null && parsedTaskEndDays > 0) {
      effectiveDueDate = await addWorkingDaysHoliday(
        effectiveStartDate,
        parsedTaskEndDays,
        workShift._id,
        false,
        {},
        deptId,
      );
    } else if (cleanField(dueDate)) {
      effectiveDueDate = await nextWorkingShiftDate(
        parseDateIST(dueDate),
        workShift._id,
        {},
        deptId,
      );
    }
    // Override due time if taskEndTime is provided
    if (effectiveDueDate && taskEndTime) {
      const [hours, minutes] = taskEndTime.split(":").map(Number);

      effectiveDueDate.setHours(hours, minutes, 0, 0);
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
      departmentOfAssignToUser: deptId,
      checklist: parsedChecklist,
    };

    //**HIMAIRA MIS CHANGE */
    if (
      isDep &&
      dependencyData.taskDependent &&
      dependencyData.startTimeSetting === "planned-to-planned"
    ) {
      try {
        let parent = null;

        if (mongoose.Types.ObjectId.isValid(dependencyData.taskDependent)) {
          parent = await Task.findById(dependencyData.taskDependent)
            .populate("assignShift")
            .lean();
        }

        if (!parent) {
          parent = await Task.findOne({
            TaskId: String(dependencyData.taskDependent),
          }).lean();
        }

        if (!parent) {
          console.log("❌ No parent task found");
        } else {
          const assignedParentUser = await User.findById(
            parent.assignedTo,
          ).populate("assignShift");

          if (!assignedParentUser) {
            return next(
              new AppError(`User with ID ${parent.assignedTo} not found`, 404),
            );
          }

          const parentWorkShift = assignedParentUser.assignShift;

          const isSameShift =
            String(workShift?._id) === String(parentWorkShift?._id);

          const parentStart = parent.startDate;
          const parentDue = parent.dueDate;

          if (!parentStart || !parentDue) {
            console.log("❌ Parent dates missing");
          } else {
            const x = Number(dependencyData.xValue) || 0;

            const freqStr = (
              dependencyData.isDependentFrequency || ""
            ).toLowerCase();

            /*
             * ============================================================
             * CHILD START DATE
             * ============================================================
             *
             * Same shift:
             *   Child starts exactly when parent starts.
             *
             * Different shift:
             *   Find the first working day for the child shift
             *   starting from parent's start date.
             */
            if (!isSameShift) {
              console.log("⚠️ Shift mismatch → using child shift calendar");

              const childStartDay = await nextWorkingShiftDate(
                parentStart,
                workShift._id,
                {},
                deptId,
              );

              commonFields.startDate = snapToShiftTime(
                childStartDay,
                workShift,
                true,
              );
            } else {
              commonFields.startDate = new Date(parentStart);
            }

            /*
             * ============================================================
             * DEPENDENT DUE DATE
             * ============================================================
             */

            let dueDate;

            /*
             * ============================================================
             * HOURS
             * ============================================================
             *
             * x = 1 means:
             *   1 working-hour after the dependency base time.
             *
             * If the calculated time crosses shift end, continue the
             * remaining hours from the NEXT WORKING DAY.
             *
             * IMPORTANT:
             * We do NOT use:
             *
             *   date.setDate(date.getDate() + 1)
             *
             * because that can land on Saturday/Sunday/holiday.
             */
            if (freqStr.includes("hour")) {
              const baseDate = isSameShift
                ? new Date(parentDue)
                : new Date(commonFields.startDate);

              let remainingHours = x;
              let currentDate = new Date(baseDate);

              /*
               * If x = 0, keep the base date/time.
               */
              if (remainingHours <= 0) {
                dueDate = currentDate;
              } else {
                while (remainingHours > 0) {
                  const currentShiftStart = snapToShiftTime(
                    currentDate,
                    workShift,
                    true,
                  );

                  const currentShiftEnd = snapToShiftTime(
                    currentDate,
                    workShift,
                    false,
                  );

                  /*
                   * Make sure currentDate is inside a valid working day.
                   */
                  const currentDayIsHoliday = await isHoliday(
                    currentDate,
                    deptId,
                  );

                  const currentDayIsWorking = await isWorkingDay(
                    currentDate,
                    workShift,
                    deptId,
                  );

                  if (currentDayIsHoliday || !currentDayIsWorking) {
                    const nextWorkingDay = await nextWorkingShiftDate(
                      new Date(currentDate.getTime() + 24 * 60 * 60 * 1000),
                      workShift._id,
                      {},
                      deptId,
                    );

                    currentDate = snapToShiftTime(
                      nextWorkingDay,
                      workShift,
                      true,
                    );

                    continue;
                  }

                  /*
                   * For the first working day, preserve the parent due
                   * time when using the same shift.
                   *
                   * For a different shift, start from child shift start.
                   */
                  if (currentDate < currentShiftStart) {
                    currentDate = currentShiftStart;
                  }

                  const availableHours =
                    (currentShiftEnd.getTime() - currentDate.getTime()) /
                    (1000 * 60 * 60);

                  if (remainingHours <= availableHours) {
                    currentDate.setTime(
                      currentDate.getTime() + remainingHours * 60 * 60 * 1000,
                    );

                    dueDate = currentDate;
                    remainingHours = 0;
                  } else {
                    /*
                     * Consume the remaining hours available today.
                     */
                    remainingHours -= Math.max(availableHours, 0);

                    /*
                     * Move to the NEXT WORKING DAY.
                     *
                     * This is the important fix.
                     */
                    const nextDay = new Date(
                      currentDate.getTime() + 24 * 60 * 60 * 1000,
                    );

                    const nextWorkingDay = await nextWorkingShiftDate(
                      nextDay,
                      workShift._id,
                      {},
                      deptId,
                    );

                    currentDate = snapToShiftTime(
                      nextWorkingDay,
                      workShift,
                      true,
                    );
                  }
                }
              }
            } else {
              /*
               * ============================================================
               * DAYS
               * ============================================================
               *
               * x = 1 means NEXT WORKING DAY.
               *
               * x = 2 means SECOND NEXT WORKING DAY.
               *
               * Example:
               *
               * Working days:
               * Monday, Tuesday, Friday, Saturday
               *
               * Start = Thursday 13 Aug
               *
               * x = 1 -> Friday 14 Aug
               * x = 2 -> Saturday 15 Aug
               * x = 3 -> Monday 17 Aug
               */
              const baseDate = isSameShift
                ? new Date(parentDue)
                : new Date(commonFields.startDate);

              /*
               * Start from the day AFTER the base date.
               */
              let candidateDate = new Date(baseDate);

              let remainingDays = x;

              if (remainingDays <= 0) {
                dueDate = new Date(baseDate);
              } else {
                while (remainingDays > 0) {
                  /*
                   * Move at least one calendar day forward.
                   */
                  candidateDate = new Date(
                    candidateDate.getTime() + 24 * 60 * 60 * 1000,
                  );

                  /*
                   * Find the next working day.
                   */
                  const candidateIsHoliday = await isHoliday(
                    candidateDate,
                    deptId,
                  );

                  const candidateIsWorkingDay = await isWorkingDay(
                    candidateDate,
                    workShift,
                    deptId,
                  );

                  if (candidateIsHoliday || !candidateIsWorkingDay) {
                    continue;
                  }

                  remainingDays--;

                  if (remainingDays === 0) {
                    dueDate = snapToShiftTime(candidateDate, workShift, false);
                  }
                }
              }
            }

            commonFields.dueDate = dueDate;

            /*
             * ============================================================
             * TASK END TIME
             * ============================================================
             */
            if (commonFields.dueDate && taskEndTime) {
              const [hours, minutes] = taskEndTime.split(":").map(Number);

              commonFields.dueDate.setHours(hours, minutes, 0, 0);
            }

            console.log("✅ DEPENDENCY DATE CALCULATION:", {
              parentStart,
              parentDue,
              childStart: commonFields.startDate,
              xValue: x,
              frequency: dependencyData.isDependentFrequency,
              finalDueDate: commonFields.dueDate,
            });
          }
        }
      } catch (err) {
        console.error("❌ Error computing dependent dates:", err);
      }
    }
    if (
      isDep &&
      dependencyData.taskDependent &&
      dependencyData.startTimeSetting === "planned-to-planned" &&
      commonFields.startDate &&
      commonFields.dueDate
    ) {
      const finalStartDate = new Date(commonFields.startDate);
      const finalDueDate = new Date(commonFields.dueDate);

      if (
        !isNaN(finalStartDate.getTime()) &&
        !isNaN(finalDueDate.getTime()) &&
        finalDueDate >= finalStartDate
      ) {
        const startDay = new Date(finalStartDate);
        const dueDay = new Date(finalDueDate);

        startDay.setHours(0, 0, 0, 0);
        dueDay.setHours(0, 0, 0, 0);

        const diffMs = dueDay.getTime() - startDay.getTime();

        // Inclusive count:
        // 13 -> 17 = 5 days
        const calculatedTaskEndDays =
          Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;

        commonFields.taskEndDays = calculatedTaskEndDays;

        console.log(
          `✅ Dependent taskEndDays | ` +
            `Start: ${startDay.toISOString()} | ` +
            `Due: ${dueDay.toISOString()} | ` +
            `taskEndDays: ${calculatedTaskEndDays}`,
        );
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
        "bi-weekly": "Bi-weekly",
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
      const isWorkDay = await isWorkingDay(
        effectiveStartDate,
        workShift,
        deptId,
      );
      if (!isWorkDay) {
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
      let recurrenceEnd = recurrenceEndDate;
      newTask = new RecurringTask({
        ...commonFields,
        frequency: modelFrequency,
        weekDays: parsedWeekDays,
        weekStartDay,
        repeatAfter,
        endDate: recurrenceEnd,
        attachmentFile: req.files
          ? req.files.map((file) => `${req.uploadFolder}/${file.filename}`)
          : [],
      });
    } else {
      const delegationTaskEndTime =
        taskEndTime ||
        (commonFields.dueDate
          ? `${String(commonFields.dueDate.getHours()).padStart(2, "0")}:${String(
              commonFields.dueDate.getMinutes(),
            ).padStart(2, "0")}`
          : null);

      newTask = new DelegationTask({
        ...commonFields,
        taskEndTime: delegationTaskEndTime,
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
    await generateRecurringTasks(newTask._id);
    const emailTemplate = taskAssignedTemplate({
      userName: assignedUser.name,

      taskId: newTask.TaskId,

      title: newTask.title,

      description: newTask.description,

      dueDate: newTask.dueDate
        ? new Date(newTask.dueDate).toLocaleString("en-IN")
        : "N/A",

      assignedBy: req.user?.name,
    });
    sendEmail({
      to: assignedUser.email,
      subject: emailTemplate.subject,
      html: emailTemplate.html,
    });
    if (newTask.taskType === "DelegationTask" && !newTask.isDependent) {
      sendNotification({
        type: "TASK_ASSIGNED",
        task: newTask,
        actor: req.user,
      });
    }

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
  let filter = { isDeleted: { $ne: true } };

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
    const { filterType, userId, role: rawRole } = req.body;
    const role = rawRole ? rawRole.toLowerCase().replace(/\s+/g, "") : "";

    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);

    let dateFilter = {};

    // 👉 TODAY
    if (filterType === "today") {
      dateFilter = {
        createdAt: { $gte: todayStart, $lte: todayEnd },
      };
    }

    // 👉 THIS WEEK (Monday Start)
    if (filterType === "week") {
      const weekStart = startOfWeek(now, { weekStartsOn: 1 });
      const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

      dateFilter = {
        createdAt: { $gte: weekStart, $lte: weekEnd },
      };
    }

    // 👉 THIS MONTH
    if (filterType === "month") {
      const monthStart = startOfMonth(now);
      const monthEnd = endOfMonth(now);

      dateFilter = {
        createdAt: { $gte: monthStart, $lte: monthEnd },
      };
    }

    // =========================
    // 👥 ROLE BASED FILTER
    // =========================
    const andConditions = [];

    if (role === "admin" || role === "owner" || role === "pc") {
      // Full access → no restriction
    } else if (role === "sr.manager" || role === "srmanager") {
      const srManagerId = userId;

      const managers = await User.find({ reportingManager: srManagerId })
        .select("_id")
        .lean();
      const managerIds = managers.map((m) => m._id);

      const members = await User.find({ reportingManager: { $in: managerIds } })
        .select("_id")
        .lean();
      const memberIds = members.map((m) => m._id);

      const allIds = [srManagerId, ...managerIds, ...memberIds];

      andConditions.push({
        $or: [{ assignedBy: { $in: allIds } }, { assignedTo: { $in: allIds } }],
      });
    } else if (role === "manager") {
      const managerId = userId;

      const memberUsers = await User.find({ reportingManager: managerId })
        .populate("role", "name")
        .select("_id role")
        .lean();

      const memberIds = memberUsers
        .filter((u) => u.role?.name === "Member")
        .map((u) => u._id);

      const allIds = [managerId, ...memberIds];

      andConditions.push({
        $or: [{ assignedBy: { $in: allIds } }, { assignedTo: { $in: allIds } }],
      });
    } else {
      // 👤 Member
      if (userId) {
        andConditions.push({ assignedTo: userId });
      }
    }

    // =========================
    // 🧠 DO_THIS TASK FILTER
    // =========================
    const filter = {
      ...dateFilter,
      taskType: { $ne: "RecurringTask" },
      isDeleted: { $ne: true },
      ...(andConditions.length > 0 && { $and: andConditions }),
    };

    // =========================
    // ⚙️ MODULE ENABLE CHECK
    // =========================
    const moduleSettings = await ModuleSetting.find({
      moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
    }).lean();

    const isModuleEnabled = (key) => {
      const mod = moduleSettings.find((m) => m.moduleKey === key);
      return mod ? mod.isEnabled : true;
    };

    const isFmsEnabled = isModuleEnabled("FMS_ENGINE");
    const isDoThisEnabled = isModuleEnabled("DO_THIS2");

    // =========================
    // 🧩 FMS FILTER BUILDING
    // =========================
    const fmsFilter = {
      isTerminated: { $ne: true },
      status: { $nin: ["Terminated"] },
    };

    // Apply role filter mapped for FMS (assignedBy -> updatedBy)
    if (andConditions.length > 0) {
      fmsFilter.$and = andConditions.map((cond) => {
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

    // Apply DATE FILTER (use plannedStartDate for FMS tasks)
    if (dateFilter.createdAt) {
      fmsFilter.plannedStartDate = dateFilter.createdAt;
    }

    // =========================
    // 🚀 PARALLEL DB EXECUTION
    // =========================
    const [tasks, fmsTasks] = await Promise.all([
      isDoThisEnabled
        ? Task.find(filter)
            .populate("assignedTo", "name email department")
            .populate("assignedBy", "name email")
            .populate("departmentOfAssignToUser", "name")
            .populate("dependencyConfig.taskDependent", "title")
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),

      isFmsEnabled
        ? FmsInstanceTask.find(fmsFilter)
            .populate("assignedTo", "name email department")
            .populate("updatedBy", "name email")
            .populate("departmentOfAssignToUser", "name")
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),
    ]);

    // Map FMS tasks to standard task format
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
      assignedBy: task.updatedBy || null,
      departmentOfAssignToUser: task.departmentOfAssignToUser,
      taskType: "FmsInstanceTask",
      createdAt: task.createdAt,
    }));

    const allTasks = [...tasks, ...mappedFmsTasks].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );

    // =========================
    // 📊 STATUS COUNTS
    // =========================
    const visibleTasks = allTasks;

    const statusCounts = {
      Pending: visibleTasks.filter((t) => t.status === "Pending").length,
      Completed: visibleTasks.filter((t) => t.status === "Completed").length,
      Delayed: visibleTasks.filter((t) => t.status === "Delayed").length,
      Upcoming: visibleTasks.filter((t) => t.status === "Upcoming").length,
      Overdue: visibleTasks.filter((t) => {
        if (t.status === "Overdue") return true;
        // Check dynamic overdue condition if status isn't explicitly set
        if (
          t.dueDate &&
          new Date(t.dueDate) < todayStart &&
          !["Completed", "Stopped", "Not Done"].includes(t.status)
        ) {
          return true;
        }
        return false;
      }).length,
    };

    return res.status(200).json({
      success: true,
      total: visibleTasks.length,
      counts: statusCounts,
      data: visibleTasks,
    });
  } catch (error) {
    console.error("Error in getAllTasksWithStats:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch tasks",
    });
  }
};

//**for my task listing - FIXED taskType filtering */
const getNextWorkingDate = async (date, workShift, userId = null) => {
  let adjustedDate = startOfDay(date);

  while (true) {
    const holiday = await isHoliday(adjustedDate, userId);

    const working = await isWorkingDay(adjustedDate, workShift, userId);

    if (!holiday && working) {
      return adjustedDate;
    }

    adjustedDate = addDays(adjustedDate, 1);
  }
};
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

  const query = { isDeleted: { $ne: true } };
  const andConditions = [];

  const now = new Date(); // 🟢 Exact current timestamp
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

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

  // 📊 STAT FILTER (🟢 FIXED STANDARD TASK OVERDUE FILTER)
  if (stat === "overdue") {
    andConditions.push({
      $or: [
        { status: "Overdue" },
        {
          dueDate: { $lt: now },
          status: { $nin: ["Completed", "Stopped", "Not Done"] },
        },
        {
          endDate: { $lt: now },
          status: { $nin: ["Completed", "Stopped", "Not Done"] },
        },
      ],
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
  if (taskType === "RecurringTask") {
    query.taskType = "DelegationTask";
    query.frequency = {
      $exists: true,
      $ne: null,
    };
  } else if (taskType === "DelegationTask") {
    query.taskType = "DelegationTask";
    query.$or = [{ frequency: { $exists: false } }, { frequency: null }];
  } else if (taskType === "All") {
    query.taskType = "DelegationTask";
  } else if (taskType === "recurring") {
    query.taskType = "RecurringTask";
  } else {
    query.taskType = { $ne: "RecurringTask" };
  }

  // 📅 DATE RANGE FILTER
  if (startDate || endDate) {
    const filter = {};

    if (startDate) {
      filter.$gte = startOfDay(parseISO(startDate));
    }

    if (endDate) {
      filter.$lte = endOfDay(parseISO(endDate));
    }

    andConditions.push({
      startDate: filter,
    });

    andConditions.push({
      dueDate: filter,
    });
  }

  // ✅ MERGE CONDITIONS
  if (andConditions.length > 0) {
    query.$and = andConditions;
  }

  if (query.status !== "Upcoming" && taskType !== "All") {
    andConditions.push({
      isVisible: true,
    });
  }

  // MODULE ENABLE CHECK
  const moduleSettings = await ModuleSetting.find({
    moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
  }).lean();

  const isModuleEnabled = (key) => {
    const mod = moduleSettings.find((m) => m.moduleKey === key);
    return mod ? mod.isEnabled : true;
  };

  const isFmsEnabled = isModuleEnabled("FMS_ENGINE");
  const isDoThisEnabled = isModuleEnabled("DO_THIS2");

  const [tasks, total] = await Promise.all([
    isDoThisEnabled
      ? Task.find(query)
          .populate("assignedTo", "name email department assignShift")
          .populate("assignedBy", "name email")
          .populate("departmentOfAssignToUser", "name")
          .populate("dependencyConfig.taskDependent", "title")
          .sort({ createdAt: -1 })
      : Promise.resolve([]),

    isDoThisEnabled ? Task.countDocuments(query) : Promise.resolve(0),
  ]);

  // RECURRING TEMPLATES
  const recurringQuery = {
    taskType: "RecurringTask",
  };

  if (andConditions.length > 0) {
    recurringQuery.$and = andConditions.filter((cond) => {
      return !(cond.startDate || cond.dueDate);
    });
  }

  const recurringTemplates = isDoThisEnabled
    ? await Task.find({
        ...recurringQuery,
        taskType: "RecurringTask",
        assignedTo: userId,
        startDate: { $exists: true },
        frequency: { $ne: "Daily" },
      })
        .populate("assignedTo", "name email department assignShift")
        .populate("assignedBy", "name email")
        .populate("departmentOfAssignToUser", "name")
        .populate("dependencyConfig.taskDependent", "title")
        .lean()
    : [];

  const recurringIds = recurringTemplates.map((t) => t._id);

  const existingInstances = await Task.find({
    recurrenceTaskId: { $in: recurringIds },
    taskType: "DelegationTask",
  }).select("recurrenceTaskId startDate");

  const existingMap = new Map();
  existingInstances.forEach((task) => {
    const key = `${task.recurrenceTaskId}_${format(
      startOfDay(task.startDate),
      "yyyy-MM-dd",
    )}`;
    existingMap.set(key, true);
  });

  const getNextOccurrence = async (template, existingMap) => {
    const today = startOfDay(new Date());

    const searchDays =
      template.frequency === "Yearly"
        ? 366 * 5
        : template.frequency === "Half Yearly"
          ? 366 * 2
          : template.frequency === "Quarterly"
            ? 366
            : 120;

    const activationDate = startOfDay(new Date(template.startDate));
    let searchDate = today > activationDate ? today : activationDate;

    const templateEndDate = template.endDate
      ? endOfDay(new Date(template.endDate))
      : null;

    const workShift = await WorkShift.findById(
      template.assignedTo?.assignShift,
    );

    const targetUserId =
      template.departmentOfAssignToUser?._id ||
      template.departmentOfAssignToUser ||
      template.assignedTo?._id ||
      template.assignedTo;

    for (let i = 0; i < searchDays; i++) {
      let date = addDays(searchDate, i);

      if (templateEndDate && date > templateEndDate) {
        break;
      }

      let isValid = false;

      if (template.frequency === "Daily") {
        isValid = true;
      } else if (template.frequency === "Weekly") {
        const currentDay = format(date, "EEEE").toLowerCase();
        isValid = template.weekDays?.includes(currentDay);
      } else if (template.frequency === "Bi-weekly") {
        const weekDays = [
          "sunday",
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
        ];

        const startIndex = weekDays.indexOf(
          template.weekStartDay?.toLowerCase(),
        );

        if (startIndex === -1) {
          isValid = false;
        } else {
          const repeatAfter = Number(template.repeatAfter || 0);
          const currentIndex = date.getDay();

          if (currentIndex === startIndex) {
            isValid = true;
          } else {
            const secondIndex = (startIndex + repeatAfter) % 7;
            isValid = currentIndex === secondIndex;
          }
        }
      } else if (template.frequency === "Fortnightly") {
        const currentDay = format(date, "EEEE").toLowerCase();
        const daysDiff = differenceInCalendarDays(date, activationDate);

        isValid =
          daysDiff >= 0 &&
          daysDiff % 14 === 0 &&
          template.weekDays?.includes(currentDay);
      } else if (template.frequency === "Monthly") {
        isValid = date.getDate() === activationDate.getDate();
      } else if (template.frequency === "Quarterly") {
        const monthsDiff =
          (date.getFullYear() - activationDate.getFullYear()) * 12 +
          (date.getMonth() - activationDate.getMonth());

        isValid =
          monthsDiff >= 0 &&
          monthsDiff % 3 === 0 &&
          date.getDate() === activationDate.getDate();
      } else if (template.frequency === "Half Yearly") {
        const monthsDiff =
          (date.getFullYear() - activationDate.getFullYear()) * 12 +
          (date.getMonth() - activationDate.getMonth());

        isValid =
          monthsDiff >= 0 &&
          monthsDiff % 6 === 0 &&
          date.getDate() === activationDate.getDate();
      } else if (template.frequency === "Yearly") {
        isValid =
          date.getMonth() === activationDate.getMonth() &&
          date.getDate() === activationDate.getDate();
      }

      if (!isValid) continue;

      const isHolidayDate = await isHoliday(date, targetUserId);
      const isWorking = await isWorkingDay(date, workShift, targetUserId);

      if (isHolidayDate || !isWorking) {
        if (template.frequency === "Weekly") continue;
        date = await getNextWorkingDate(date, workShift, targetUserId);
      }

      const key = `${template._id}_${format(startOfDay(date), "yyyy-MM-dd")}`;

      if (existingMap.has(key)) continue;

      return date;
    }

    return null;
  };

  const futureRecurring = await Promise.all(
    recurringTemplates.map(async (template) => {
      const nextOccurrence = await getNextOccurrence(template, existingMap);

      if (!nextOccurrence) return null;

      return {
        ...template,
        originalTaskType: template.taskType,
        taskType: "FutureRecurringTask",
        displayTaskType: "DelegationTask",
        startDate: nextOccurrence,
        dueDate: nextOccurrence,
        status: "Upcoming",
        isVirtualRecurring: true,
      };
    }),
  );

  let filteredRecurring = futureRecurring.filter(Boolean);

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

  let finalVirtualRecurring = filteredRecurring;

  if (status && status !== "all") {
    finalVirtualRecurring = finalVirtualRecurring.filter(
      (task) => task.status === status,
    );
  }

  if (taskType) {
    finalVirtualRecurring = finalVirtualRecurring.filter(
      (task) => task.taskType === taskType || task.isVirtualRecurring,
    );
  }

  if (search) {
    finalVirtualRecurring = finalVirtualRecurring.filter((task) =>
      task.title.toLowerCase().includes(search.toLowerCase()),
    );
  }

  // FMS TASKS QUERY
  const fmsQuery = {};

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

  if (search) {
    fmsQuery.$or = [
      { description: { $regex: search, $options: "i" } },
      { taskId: search },
    ];
  }

  if (status && status !== "all") fmsQuery.status = status;

  if (startDate || endDate) {
    const dateFilter = {};
    if (startDate) dateFilter.$gte = startOfDay(parseISO(startDate));
    if (endDate) dateFilter.$lte = endOfDay(parseISO(endDate));
    fmsQuery.$or = [
      { plannedStartDate: dateFilter },
      { plannedDueDate: dateFilter },
    ];
  }

  // 📊 STAT FILTER (🟢 FIXED FMS TASK OVERDUE FILTER)
  if (stat === "overdue") {
    fmsQuery.$or = [
      { status: "Overdue" },
      {
        plannedDueDate: { $lt: now },
        status: { $nin: ["Completed", "Stopped", "Not Done"] },
      },
    ];
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

  if (taskCategory !== "upcoming" && status && status !== "all") {
    fmsQuery.status = status;
  }

  const [fmsTasks, fmsTotal] = await Promise.all([
    isFmsEnabled
      ? FmsInstanceTask.find(fmsQuery)
          .populate("assignedTo", "name email department assignShift")
          .populate("assignedBy", "name email")
          .populate("updatedBy", "name email")
          .populate("departmentOfAssignToUser", "name")
          .sort({ createdAt: -1 })
          .lean()
      : Promise.resolve([]),
    isFmsEnabled
      ? FmsInstanceTask.countDocuments(fmsQuery)
      : Promise.resolve(0),
  ]);

  const mappedFmsTasks = isFmsEnabled
    ? fmsTasks.map((task) => ({
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
      }))
    : [];

  let allTasks = [...tasks];

  const totalTasks = allTasks.length;
  const paginatedTasks = allTasks.slice(skip, skip + Number(limit));

  let recurringResponse = [];
  const shouldShowFutureRecurring =
    taskCategory === "upcoming" && (!taskType || taskType === "RecurringTask");

  if (shouldShowFutureRecurring) {
    recurringResponse = finalVirtualRecurring;
  }

  res.json({
    success: true,
    data: paginatedTasks,
    upcomingRecurringTasks: isDoThisEnabled ? recurringResponse : [],
    totalTasks: totalTasks,
    currentPage: page,
    totalPages: Math.ceil(totalTasks / limit),
  });
});
export const filterFMSTasks = handleAsync(async (req, res) => {
  const {
    userId,
    role,
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

  const now = new Date(); // 🟢 Exact current date & time
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  // =========================
  // MODULE ENABLE CHECK
  // =========================
  const moduleSettings = await ModuleSetting.find({
    moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
  }).lean();

  const isModuleEnabled = (key) => {
    const mod = moduleSettings.find((m) => m.moduleKey === key);
    return mod ? mod.isEnabled : true;
  };

  const isFmsEnabled = isModuleEnabled("FMS_ENGINE");

  // =========================
  // FMS BASE QUERY
  // =========================
  const fmsQuery = {
    isTerminated: { $ne: true },
    status: { $nin: ["Terminated"] },
  };

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
  if (assignedBy) fmsQuery.assignedBy = assignedBy;

  // SEARCH
  if (search) {
    fmsQuery.$or = [
      { description: { $regex: search, $options: "i" } },
      { taskId: search },
    ];
  }

  // STATUS
  if (status && status !== "all") fmsQuery.status = status;

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
  // 📊 STATUS / STAT FILTER (🟢 FIXED OVERDUE FILTER)
  // =========================
  if (stat === "overdue") {
    fmsQuery.$or = [
      { status: "Overdue" },
      {
        plannedDueDate: { $lt: now },
        status: { $nin: ["Completed", "Stopped", "Not Done"] },
      },
    ];
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

  // DIRECT STATUS FILTER OVERRIDE
  if (taskCategory !== "upcoming" && status && status !== "all") {
    fmsQuery.status = status;
  }

  // =========================
  // EXECUTE QUERIES
  // =========================
  const [fmsTasks, fmsTotal] = await Promise.all([
    isFmsEnabled
      ? FmsInstanceTask.find(fmsQuery)
          .populate("assignedTo", "name email department assignShift")
          .populate("assignedBy", "name email")
          .populate("notDoneBy", "name email")
          .populate("updatedBy", "name email")
          .populate("departmentOfAssignToUser", "name")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .lean()
      : Promise.resolve([]),
    isFmsEnabled
      ? FmsInstanceTask.countDocuments(fmsQuery)
      : Promise.resolve(0),
  ]);

  const mappedFmsTasks = isFmsEnabled
    ? fmsTasks.map((task) => ({
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
      }))
    : [];

  res.json({
    success: true,
    data: mappedFmsTasks,
    totalTasks: fmsTotal,
    currentPage: Number(page),
    totalPages: Math.ceil(fmsTotal / limit),
  });
});
//**export my task */
export const exportMYTasks = handleAsync(async (req, res) => {
  const {
    userId,
    search,
    filters = {},
    creatorOrAssignorId,
    departmentId,
    createdBy,
    assignedBy,
    startDate,
    endDate,
  } = req.body;

  const { stat, taskCategory, status, taskType } = filters;

  const query = { isDeleted: { $ne: true } };
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
  if (taskType === "RecurringTask") {
    // User only wants virtual upcoming recurring tasks
    query.taskType = "__NO_TASKS__"; // impossible value
  } else if (taskType) {
    query.taskType = taskType;
  } else {
    // default hide recurring templates
    query.taskType = { $ne: "RecurringTask" };
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
  // =========================
  // MODULE ENABLE CHECK
  // =========================

  const moduleSettings = await ModuleSetting.find({
    moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
  }).lean();

  const isModuleEnabled = (key) => {
    const mod = moduleSettings.find((m) => m.moduleKey === key);
    return mod ? mod.isEnabled : true;
  };

  const isFmsEnabled = isModuleEnabled("FMS_ENGINE");
  const isDoThisEnabled = isModuleEnabled("DO_THIS2");

  // query.taskType = { $ne: "RecurringTask" };
  // 🚀 QUERY EXECUTION
  const [tasks, total] = await Promise.all([
    isDoThisEnabled
      ? Task.find(query) // 🔥 Only visible tasks
          .populate("assignedTo", "name email department assignShift")
          .populate("assignedBy", "name email")
          .populate("departmentOfAssignToUser", "name")
          .populate("dependencyConfig.taskDependent", "title")
          .sort({ createdAt: -1 })
      : Promise.resolve([]),

    // .skip(skip)
    // .limit(limit)
    isDoThisEnabled ? Task.countDocuments(query) : Promise.resolve(0), // 🔥 Count only visible
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
  const recurringTemplates = isDoThisEnabled
    ? await Task.find({
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
        .lean()
    : [];
  const recurringIds = recurringTemplates.map((t) => t._id);

  const existingInstances = await Task.find({
    recurrenceTaskId: { $in: recurringIds },
    taskType: "DelegationTask",
  }).select("recurrenceTaskId startDate");
  const existingMap = new Map();

  existingInstances.forEach((task) => {
    const key = `${task.recurrenceTaskId}_${format(
      startOfDay(task.startDate),
      "yyyy-MM-dd",
    )}`;

    existingMap.set(key, true);
  });
  const getNextOccurrence = async (template, existingMap) => {
    const today = startOfDay(new Date());

    const searchDays =
      template.frequency === "Yearly"
        ? 366 * 5
        : template.frequency === "Half Yearly"
          ? 366 * 2
          : template.frequency === "Quarterly"
            ? 366
            : 120;

    const activationDate = startOfDay(new Date(template.startDate));

    let searchDate = today > activationDate ? today : activationDate;

    const templateEndDate = template.endDate
      ? endOfDay(new Date(template.endDate))
      : null;

    // user shift
    const workShift = await WorkShift.findById(
      template.assignedTo?.assignShift,
    );

    const targetUserId =
      template.departmentOfAssignToUser?._id ||
      template.departmentOfAssignToUser ||
      template.assignedTo?._id ||
      template.assignedTo;

    for (let i = 0; i < searchDays; i++) {
      let date = addDays(searchDate, i);

      if (templateEndDate && date > templateEndDate) {
        break;
      }

      let isValid = false;

      // ==================================================
      // DAILY
      // ==================================================
      if (template.frequency === "Daily") {
        isValid = true;
      }

      // ==================================================
      // WEEKLY
      // ==================================================
      else if (template.frequency === "Weekly") {
        const currentDay = format(date, "EEEE").toLowerCase();

        isValid = template.weekDays?.includes(currentDay);
      }

      // ==================================================
      // FORTNIGHTLY
      // ==================================================
      else if (template.frequency === "Fortnightly") {
        const currentDay = format(date, "EEEE").toLowerCase();

        const daysDiff = differenceInCalendarDays(date, activationDate);

        isValid =
          daysDiff >= 0 &&
          daysDiff % 14 === 0 &&
          template.weekDays?.includes(currentDay);
      }

      // ==================================================
      // MONTHLY
      // ==================================================
      else if (template.frequency === "Monthly") {
        isValid = date.getDate() === activationDate.getDate();
      }

      // ==================================================
      // QUARTERLY
      // ==================================================
      else if (template.frequency === "Quarterly") {
        const monthsDiff =
          (date.getFullYear() - activationDate.getFullYear()) * 12 +
          (date.getMonth() - activationDate.getMonth());

        isValid =
          monthsDiff >= 0 &&
          monthsDiff % 3 === 0 &&
          date.getDate() === activationDate.getDate();
      }

      // ==================================================
      // HALF YEARLY
      // ==================================================
      else if (template.frequency === "Half Yearly") {
        const monthsDiff =
          (date.getFullYear() - activationDate.getFullYear()) * 12 +
          (date.getMonth() - activationDate.getMonth());

        isValid =
          monthsDiff >= 0 &&
          monthsDiff % 6 === 0 &&
          date.getDate() === activationDate.getDate();
      }

      // ==================================================
      // YEARLY
      // ==================================================
      else if (template.frequency === "Yearly") {
        isValid =
          date.getMonth() === activationDate.getMonth() &&
          date.getDate() === activationDate.getDate();
      }

      if (!isValid) continue;

      // ==================================================
      // CHECK HOLIDAY / WORKING DAY
      // ==================================================

      const isHolidayDate = await isHoliday(date, targetUserId);

      const isWorking = await isWorkingDay(date, workShift, targetUserId);

      if (isHolidayDate || !isWorking) {
        // Weekly/Fortnightly:
        // skip this weekday and continue searching
        if (template.frequency === "Weekly") {
          continue;
        }

        // Monthly/Quarterly/HalfYearly/Yearly:
        // push to next working day
        date = await getNextWorkingDate(date, workShift, targetUserId);
      }
      // ==================================================
      // SKIP already created occurrence
      // ==================================================

      const key = `${template._id}_${format(startOfDay(date), "yyyy-MM-dd")}`;

      if (existingMap.has(key)) {
        continue;
      }

      return date;
    }

    return null;
  };
  const futureRecurring = await Promise.all(
    recurringTemplates.map(async (template) => {
      const nextOccurrence = await getNextOccurrence(template, existingMap);

      if (!nextOccurrence) return null;

      return {
        ...template,

        originalTaskType: template.taskType,

        taskType: "FutureRecurringTask",

        displayTaskType: "DelegationTask",

        startDate: nextOccurrence,

        dueDate: nextOccurrence,

        status: "Upcoming",

        isVirtualRecurring: true,
      };
    }),
  );

  let filteredRecurring = futureRecurring.filter(Boolean);

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
    fmsQuery.status = { $nin: ["Completed", "Stopped"] };
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
  if (taskCategory !== "upcoming" && status && status !== "all") {
    fmsQuery.status = status;
  }

  const [fmsTasks, fmsTotal] = await Promise.all([
    isFmsEnabled
      ? FmsInstanceTask.find(fmsQuery)
          .populate("assignedTo", "name email department assignShift")
          .populate("assignedBy", "name email")
          .populate("updatedBy", "name email") // use as assignedBy fallback
          .populate("departmentOfAssignToUser", "name")
          .sort({ createdAt: -1 })
          .lean()
      : Promise.resolve([]),

    isFmsEnabled
      ? FmsInstanceTask.countDocuments(fmsQuery)
      : Promise.resolve(0),
  ]);
  const mappedFmsTasks = isFmsEnabled
    ? fmsTasks.map((task) => ({
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
      }))
    : [];
  let allTasks = [...mappedFmsTasks];

  const totalTasks = allTasks.length;

  const finalData = [...allTasks];

  res.json({
    success: true,
    total: finalData.length,
    data: finalData,
  });
});

export const exportMYFMSTasks = handleAsync(async (req, res) => {
  const {
    userId,
    search,
    filters = {},
    creatorOrAssignorId,
    departmentId,
    createdBy,
    assignedBy,
    startDate,
    endDate,
  } = req.body;

  const { stat, taskCategory, status, taskType } = filters;

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

  const moduleSettings = await ModuleSetting.find({
    moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
  }).lean();

  const isModuleEnabled = (key) => {
    const mod = moduleSettings.find((m) => m.moduleKey === key);
    return mod ? mod.isEnabled : true;
  };

  const isFmsEnabled = isModuleEnabled("FMS_ENGINE");
  const isDoThisEnabled = isModuleEnabled("DO_THIS2");

  const fmsQuery = {};

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

  if (search) {
    fmsQuery.$or = [
      { description: { $regex: search, $options: "i" } },
      { taskId: search },
    ];
  }

  if (status && status !== "all") fmsQuery.status = status;

  if (startDate || endDate) {
    const dateFilter = {};
    if (startDate) dateFilter.$gte = startOfDay(parseISO(startDate));
    if (endDate) dateFilter.$lte = endOfDay(parseISO(endDate));
    fmsQuery.$or = [
      { plannedStartDate: dateFilter },
      { plannedDueDate: dateFilter },
    ];
  }

  if (stat === "overdue") {
    fmsQuery.plannedDueDate = { $lt: todayStart };
    fmsQuery.status = { $nin: ["Completed", "Stopped"] };
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

  if (taskCategory !== "upcoming" && status && status !== "all") {
    fmsQuery.status = status;
  }

  const [fmsTasks, fmsTotal] = await Promise.all([
    isFmsEnabled
      ? FmsInstanceTask.find(fmsQuery)
          .populate("assignedTo", "name email department assignShift")
          .populate("assignedBy", "name email")
          .populate("updatedBy", "name email") // use as assignedBy fallback
          .populate("departmentOfAssignToUser", "name")
          .sort({ createdAt: -1 })
          .lean()
      : Promise.resolve([]),

    isFmsEnabled
      ? FmsInstanceTask.countDocuments(fmsQuery)
      : Promise.resolve(0),
  ]);
  const mappedFmsTasks = isFmsEnabled
    ? fmsTasks.map((task) => ({
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
      }))
    : [];
  let allTasks = [...mappedFmsTasks];

  const totalTasks = allTasks.length;

  const finalData = [...allTasks];

  res.json({
    success: true,
    total: finalData.length,
    data: finalData,
  });
});

export const getTaskStats = handleAsync(async (req, res) => {
  const { userId, creatorOrAssignorId, departmentId, createdBy } = req.body;

  const baseConditions = [];

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

  const moduleSettings = await ModuleSetting.find({
    moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
  }).lean();

  const isModuleEnabled = (key) => {
    const mod = moduleSettings.find((m) => m.moduleKey === key);
    return mod ? mod.isEnabled : true;
  };

  const isFmsEnabled = isModuleEnabled("FMS_ENGINE");
  const isDoThisEnabled = isModuleEnabled("DO_THIS2");

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

  const baseQuery = { isDeleted: { $ne: true } };

  if (baseConditions.length > 0) {
    baseQuery.$and = baseConditions;
  }

  baseQuery.isVisible = true;

  const [total, completed, pending, overdue] = await Promise.all([
    isDoThisEnabled
      ? Task.countDocuments({
          ...baseQuery,
          taskType: { $ne: "RecurringTask" },
        })
      : Promise.resolve(0),

    isDoThisEnabled
      ? Task.countDocuments({
          ...baseQuery,
          taskType: { $ne: "RecurringTask" },
          status: "Completed",
        })
      : Promise.resolve(0),

    isDoThisEnabled
      ? Task.countDocuments({
          ...baseQuery,
          taskType: { $ne: "RecurringTask" },
          status: "Pending",
        })
      : Promise.resolve(0),

    isDoThisEnabled
      ? Task.countDocuments({
          ...baseQuery,
          taskType: { $ne: "RecurringTask" },
          $and: [
            ...(baseQuery.$and || []),
            {
              taskType: "DelegationTask",
              dueDate: { $lt: todayStart },
            },
            {
              status: { $ne: "Completed" },
            },
          ],
        })
      : Promise.resolve(0),
  ]);

  const fmsQuery = {};

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

  const [fmsTotal, fmsCompleted, fmsPending, fmsOverdue] = await Promise.all([
    isFmsEnabled
      ? FmsInstanceTask.countDocuments(fmsQuery)
      : Promise.resolve(0),

    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          status: "Completed",
        })
      : Promise.resolve(0),

    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          status: "Pending",
        })
      : Promise.resolve(0),

    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          plannedDueDate: { $lt: todayStart },
          status: { $nin: ["Completed", "Stopped"] },
        })
      : Promise.resolve(0),
  ]);

  res.json({
    success: true,
    stats: {
      total: total,
      completed: completed,
      pending: pending,
      overdue: overdue,
    },
  });
});

export const getFMSTaskStats = handleAsync(async (req, res) => {
  const { userId, role, creatorOrAssignorId, departmentId, createdBy } =
    req.body;

  const now = new Date(); // 🟢 Exact current timestamp with hours & minutes

  const moduleSettings = await ModuleSetting.find({
    moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
  }).lean();

  const isModuleEnabled = (key) => {
    const mod = moduleSettings.find((m) => m.moduleKey === key);
    return mod ? mod.isEnabled : true;
  };

  const isFmsEnabled = isModuleEnabled("FMS_ENGINE");

  const fmsQuery = {
    isTerminated: { $ne: true },
    status: { $nin: ["Terminated"] },
  };

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

  const [fmsTotal, fmsCompleted, fmsPending, fmsOverdue] = await Promise.all([
    isFmsEnabled
      ? FmsInstanceTask.countDocuments(fmsQuery)
      : Promise.resolve(0),

    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          status: "Completed",
        })
      : Promise.resolve(0),

    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          status: "Pending",
        })
      : Promise.resolve(0),

    // 🟢 FIXED OVERDUE COUNT (Check status OR exact time past plannedDueDate)
    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          $or: [
            { status: "Overdue" },
            {
              plannedDueDate: { $lt: now },
              status: { $nin: ["Completed", "Stopped", "Not Done"] },
            },
          ],
        })
      : Promise.resolve(0),
  ]);

  res.json({
    success: true,
    stats: {
      total: fmsTotal,
      completed: fmsCompleted,
      pending: fmsPending,
      overdue: fmsOverdue,
    },
  });
});

export const getRoleBasedTasks = handleAsync(async (req, res) => {
  const {
    userId,
    role: rawRole,
    departmentId,
    page = 1,
    limit = 10,
    search,
    filters = {},
    assignedBy,
    selectedDoer,
    selectedManager,
    selectedSrManager,
    selectedTemplate,
    taskTypeFilter = "all", // "all" | "dothis" | "fms"
  } = req.body;

  const role = rawRole ? rawRole.toLowerCase().replace(/\s+/g, "") : "";
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const { stat, taskCategory, status, taskType } = filters;

  const now = new Date(); // 🟢 Exact current date & time
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  const moduleSettings = await ModuleSetting.find({
    moduleKey: { $in: ["FMS_ENGINE", "DO_THIS2"] },
  }).lean();

  const isModuleEnabled = (key) => {
    const mod = moduleSettings.find((m) => m.moduleKey === key);
    return mod ? mod.isEnabled : true;
  };

  const shouldFetchDoThis =
    isModuleEnabled("DO_THIS2") &&
    (taskTypeFilter === "all" || taskTypeFilter === "dothis");

  const shouldFetchFms =
    isModuleEnabled("FMS_ENGINE") &&
    (taskTypeFilter === "all" || taskTypeFilter === "fms");

  const query = { isDeleted: { $ne: true } };
  const andConditions = [];

  if (shouldFetchDoThis) {
    if (role === "admin" || role === "owner" || role === "pc") {
      if (selectedDoer && selectedDoer !== "all") {
        andConditions.push({ assignedTo: selectedDoer });
      }
      if (selectedManager && selectedManager !== "all") {
        andConditions.push({
          $or: [
            { assignedBy: selectedManager },
            { assignedTo: selectedManager },
          ],
        });
      }
      if (selectedSrManager && selectedSrManager !== "all") {
        andConditions.push({
          $or: [
            { assignedBy: selectedSrManager },
            { assignedTo: selectedSrManager },
          ],
        });
      }
    } else if (role === "sr.manager" || role === "srmanager") {
      const managers = await User.find({ reportingManager: userId })
        .select("_id")
        .lean();
      const managerIds = managers.map((m) => m._id);

      const members = await User.find({ reportingManager: { $in: managerIds } })
        .select("_id")
        .lean();
      const memberIds = members.map((m) => m._id);

      const allIds = [userId, ...managerIds, ...memberIds];
      andConditions.push({
        $or: [{ assignedBy: { $in: allIds } }, { assignedTo: { $in: allIds } }],
      });

      if (selectedManager && selectedManager !== "all") {
        andConditions.push({
          $or: [
            { assignedBy: selectedManager },
            { assignedTo: selectedManager },
          ],
        });
      }
      if (selectedDoer && selectedDoer !== "all") {
        andConditions.push({ assignedTo: selectedDoer });
      }
    } else if (role === "manager") {
      const memberUsers = await User.find({ reportingManager: userId })
        .populate("role", "name")
        .select("_id role")
        .lean();

      const memberIds = memberUsers
        .filter((u) => u.role?.name === "Member")
        .map((u) => u._id);

      const allIds = [userId, ...memberIds];
      andConditions.push({
        $or: [{ assignedBy: { $in: allIds } }, { assignedTo: { $in: allIds } }],
      });

      if (selectedDoer && selectedDoer !== "all") {
        andConditions.push({ assignedTo: selectedDoer });
      }
    } else {
      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        andConditions.push({ assignedTo: userId });
      }
    }

    if (search) {
      andConditions.push({
        $or: [{ title: { $regex: search, $options: "i" } }, { TaskId: search }],
      });
    }

    // 🟢 FIXED OVERDUE FILTER (Check status OR exact time past due date)
    if (stat === "overdue") {
      andConditions.push({
        $or: [
          { status: "Overdue" },
          {
            dueDate: { $lt: now },
            status: { $nin: ["Completed", "Stopped", "Not Done"] },
          },
          {
            endDate: { $lt: now },
            status: { $nin: ["Completed", "Stopped", "Not Done"] },
          },
        ],
      });
    }

    if (stat === "dueToday") {
      andConditions.push({ dueDate: { $gte: todayStart, $lte: todayEnd } });
    }

    if (stat === "completed") {
      andConditions.push({ status: "Completed" });
    }

    if (!stat) {
      if (taskCategory === "today_backlog") {
        andConditions.push({
          status: { $in: ["Pending", "Delayed", "Overdue"] },
          taskType: "DelegationTask",
          startDate: { $gte: todayStart, $lte: todayEnd },
        });
      }
      if (taskCategory === "upcoming") query.status = "Upcoming";
      if (taskCategory === "completed") query.status = "Completed";
    }

    if (status && status !== "all") {
      if (status === "Reopened") {
        andConditions.push({ isReopen: true });
      } else {
        andConditions.push({ status });
      }
    }

    if (taskType === "RecurringTask") {
      andConditions.push({ taskType: "__NO_TASKS__" });
    } else if (taskType) {
      andConditions.push({ taskType });
    } else {
      andConditions.push({ taskType: { $ne: "RecurringTask" } });
    }

    if (assignedBy && mongoose.Types.ObjectId.isValid(assignedBy)) {
      andConditions.push({ assignedBy });
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }
  }

  const fmsQuery = {
    isTerminated: { $ne: true },
    status: { $nin: ["Terminated"] },
  };
  const fmsAndConditions = [];

  if (shouldFetchFms) {
    if (selectedTemplate && selectedTemplate !== "all") {
      const matchingInstances = await FmsInstance.find({
        fmsTemplateId: selectedTemplate,
      })
        .select("_id")
        .lean();

      const instanceIds = matchingInstances.map((i) => i._id);
      fmsAndConditions.push({ fmsInstanceId: { $in: instanceIds } });
    }
    if (role === "admin" || role === "owner" || role === "pc") {
      if (selectedDoer && selectedDoer !== "all") {
        fmsAndConditions.push({ assignedTo: selectedDoer });
      }
      if (selectedManager && selectedManager !== "all") {
        fmsAndConditions.push({
          $or: [
            { updatedBy: selectedManager },
            { assignedTo: selectedManager },
          ],
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
    } else if (role === "sr.manager" || role === "srmanager") {
      const managers = await User.find({ reportingManager: userId })
        .select("_id")
        .lean();
      const managerIds = managers.map((m) => m._id);

      const members = await User.find({ reportingManager: { $in: managerIds } })
        .select("_id")
        .lean();
      const memberIds = members.map((m) => m._id);

      const allIds = [userId, ...managerIds, ...memberIds];
      fmsAndConditions.push({ assignedTo: { $in: allIds } });
    } else if (role === "manager") {
      const members = await User.find({ reportingManager: userId })
        .select("_id")
        .lean();
      const memberIds = members.map((m) => m._id);

      const allIds = [userId, ...memberIds];
      fmsAndConditions.push({ assignedTo: { $in: allIds } });
    } else {
      fmsAndConditions.push({ assignedTo: userId });
    }

    if (search) {
      fmsAndConditions.push({
        $or: [
          { description: { $regex: search, $options: "i" } },
          { taskId: search },
        ],
      });
    }

    if (status && status !== "all") {
      fmsAndConditions.push({ status });
    }

    // 🟢 FIXED FMS OVERDUE FILTER
    if (stat === "overdue") {
      fmsAndConditions.push({
        $or: [
          { status: "Overdue" },
          {
            plannedDueDate: { $lt: now },
            status: { $nin: ["Completed", "Stopped", "Not Done"] },
          },
        ],
      });
    }

    if (stat === "dueToday") {
      fmsAndConditions.push({
        plannedDueDate: { $gte: todayStart, $lte: todayEnd },
      });
    }

    if (!stat) {
      if (taskCategory === "today_backlog") {
        fmsAndConditions.push({
          status: { $in: ["Pending", "Delayed", "Overdue"] },
          plannedStartDate: { $gte: todayStart, $lte: todayEnd },
        });
      }
      if (taskCategory === "upcoming")
        fmsAndConditions.push({ status: "Upcoming" });
      if (taskCategory === "completed")
        fmsAndConditions.push({ status: "Completed" });
    }

    if (fmsAndConditions.length > 0) {
      fmsQuery.$and = fmsAndConditions;
    }
  }

  const [tasksResult, tasksTotal, fmsTasksResult, fmsTotal] = await Promise.all(
    [
      shouldFetchDoThis
        ? Task.find(query)
            .populate("assignedTo", "name email department")
            .populate("assignedBy", "name email")
            .populate("departmentOfAssignToUser", "name")
            .populate("dependencyConfig.taskDependent", "title")
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),

      shouldFetchDoThis ? Task.countDocuments(query) : Promise.resolve(0),

      shouldFetchFms
        ? FmsInstanceTask.find(fmsQuery)
            .populate("assignedTo", "name email department assignShift")
            .populate("assignedBy", "name email")
            .populate("updatedBy", "name email")
            .populate("departmentOfAssignToUser", "name")
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),

      shouldFetchFms
        ? FmsInstanceTask.countDocuments(fmsQuery)
        : Promise.resolve(0),
    ],
  );

  const mappedFmsTasks =
    shouldFetchFms && Array.isArray(fmsTasksResult)
      ? fmsTasksResult.map((task) => ({
          ...task,
          _id: task._id,
          TaskId: task.taskId,
          title: task.description,
          description: task.description,
          startDate: task.plannedStartDate,
          dueDate: task.plannedDueDate,
          status: task.status,
          assignedTo: task.assignedTo,
          assignedBy: task.assignedBy || task.updatedBy || null,
          departmentOfAssignToUser: task.departmentOfAssignToUser,
          taskType: "FmsInstanceTask",
          isVisible: task.isVisible,
          checklist: task.checklist || [],
          createdAt: task.createdAt,
        }))
      : [];

  const mappedTasks =
    shouldFetchDoThis && Array.isArray(tasksResult)
      ? tasksResult.map((task) => normalizeTask(task))
      : [];

  const merged = [...mappedTasks, ...mappedFmsTasks].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );

  const totalTasks = tasksTotal + fmsTotal;
  const paginatedTasks = merged.slice(skip, skip + limitNum);

  res.json({
    success: true,
    data: paginatedTasks,
    totalTasks,
    currentPage: pageNum,
    totalPages: Math.ceil(totalTasks / limitNum) || 1,
  });
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
    creatorOrAssignorId,
    page = 1,
    limit = 10,
    taskCategory,
    type,
  } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  let tasks = [];
  let total = 0;

  const filterQuery = { isDeleted: { $ne: true } };
  const today = startOfDay(new Date());
  const loggedInUserId = req.cookies.userId || req.user?._id;

  const loggedInUser = await User.findById(loggedInUserId).populate(
    "role",
    "name",
  );

  const roleName = loggedInUser?.role?.name?.toLowerCase();

  const isSuperUser = roleName === "admin" || roleName === "owner";

  if (!isSuperUser) {
    filterQuery.createdBy = loggedInUserId;
  }
  if (creatorOrAssignorId) {
    filterQuery.$or = [
      { createdBy: creatorOrAssignorId },
      { assignedBy: creatorOrAssignorId },
    ];
  } else {
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
  }
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

    if (Object.keys(filterQuery).length > 0) {
      filterQuery.$and = filterQuery.$and || [];
      filterQuery.$and.push(categoryFilter);
    } else {
      Object.assign(filterQuery, categoryFilter);
    }
  }
  if (dateFilter) {
    if (dateFilter === "overdue") {
      filterQuery.dueDate = { $lt: today };
    } else if (dateFilter === "dueToday") {
      filterQuery.dueDate = {
        $gte: today,
        $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000),
      };
    }
  }

  if (status && status !== "all") {
    filterQuery.status = status;
  }

  if (search) {
    const searchQuery = {
      $or: [{ title: { $regex: search, $options: "i" } }, { TaskId: search }],
    };

    let finalQuery;
    if (filterQuery.$or) {
      finalQuery = { $and: [filterQuery, searchQuery] };
    } else {
      finalQuery = { ...filterQuery, ...searchQuery };
    }
    if (query.status !== "Upcoming") {
      finalQuery.isVisible = true;
    }
    total = await Task.countDocuments(finalQuery);

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
    totalTasks: total,
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
  if (task.status === "Completed") {
    try {
      const parentCompletedAt = task.completedAt || new Date();

      const children = await Task.find({
        "dependencyConfig.taskDependent": task._id,
      }).exec();

      for (const child of children) {
        const dep = child.dependencyConfig || {};
        const startSetting = (dep.startTimeSetting || "").toLowerCase();

        if (startSetting === "actual-to-planned") {
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
            const addDays = Math.max(0, Number(durationDays) - 1);
            newDue = new Date(newStart);
            newDue.setDate(newDue.getDate() + addDays);
          }

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

  const existingTask = await Task.findById(id)
    .populate("assignedTo", "name email assignShift")
    .populate("assignedBy", "name email");

  if (!existingTask) return next(new AppError("Task not found", 404));

  let conversation = null;

  if (existingTask.conversationId) {
    conversation = await Conversations.findById(existingTask.conversationId);
  }

  if (!conversation) {
    conversation = await Conversations.create({
      taskId: existingTask._id,
      taskType: existingTask.taskType,
      participants: [
        existingTask.assignedTo?._id,
        existingTask.assignedBy?._id,
      ].filter(Boolean),
    });

    existingTask.conversationId = conversation._id;
    await existingTask.save();
  }

  const oldData = existingTask.toObject();

  const updateData = {
    completeStatus,
    updatedBy: req.user._id,
  };

  if (completeStatus) {
    // 1. CHECKLIST VALIDATION
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

    // 2. SOCKET & NOTIFICATIONS
    const io = getIO();

    if (
      existingTask.assignedBy?._id &&
      existingTask.assignedBy._id.toString() !==
        existingTask.assignedTo?._id?.toString()
    ) {
      io.to(existingTask.assignedBy._id.toString()).emit("notification", {
        type: "TASK_COMPLETED",
        title: "Task Completed",
        description: `Task "${existingTask.title}" completed.`,
        taskId: existingTask._id,
        TaskId: existingTask.TaskId,
      });
    }

    const frontendUrl = `${process.env.BASE_URL}/my-day/view`;

    if (
      existingTask.assignedBy?.email &&
      existingTask.assignedBy._id.toString() !==
        existingTask.assignedTo._id.toString()
    ) {
      const emailTemplate = taskCompletedTemplate({
        assignedByName: existingTask.assignedBy?.name || "Manager",
        completedBy: existingTask.assignedTo?.name || "User",
        taskId: existingTask.TaskId,
        title: existingTask.title,
        remark: existingTask.remark || "",
        completedAt: existingTask.completedAt || "",
        frontendUrl,
      });

      sendEmail({
        to: existingTask.assignedBy.email,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
      });
    }

    sendNotification({
      type: "TASK_COMPLETED",
      task: existingTask,
      actor: req.user,
      userId: existingTask.assignedBy._id,
    });

    if (
      existingTask.assignedBy?._id &&
      existingTask.assignedBy._id.toString() !==
        existingTask.assignedTo._id.toString()
    ) {
      await Notifications.create({
        user: existingTask.assignedBy._id,
        fromUser: existingTask.assignedTo._id,
        type: "TASK_COMPLETED",
        title: "Task Completed",
        description: `Task "${existingTask.title}" completed please check your email.`,
        relatedId: existingTask._id,
        taskId: existingTask._id,
        conversationId: conversation._id,
      });
    }

    updateData.isReopen = false;
    updateData.reopenedBy = null;
    updateData.reopenedAt = null;
    updateData.reopenedReason = null;

    updateData.status = "Completed";
    updateData.taskDoneBy = req.cookies.userId || req.user._id;
    updateData.completedAt = new Date();
  } else {
    updateData.status = "Pending";
    updateData.taskDoneBy = null;
    updateData.completedAt = null;
  }

  const updatedTask = await Task.findByIdAndUpdate(id, updateData, {
    new: true,
  });

  const newData = updatedTask.toObject();

  const message = completeStatus
    ? `✅ Task "${updatedTask.title}" marked as completed`
    : `↩️ Task "${updatedTask.title}" marked as pending`;

  await createLog({
    action: "UPDATE",
    module: "TASK",
    documentId: updatedTask._id,
    performedBy: req.user._id,
    oldData,
    newData,
    message,
  });

  const justCompleted =
    completeStatus === true && oldData.status !== "Completed";

  // 3. UNLOCK & CALCULATE DEPENDENT TASKS (ACTUAL-TO-PLANNED)
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

    const assignedParentUser = await User.findById(
      updatedTask.assignedTo,
    ).populate("assignShift");

    if (!assignedParentUser) {
      return next(
        new AppError(`User with ID ${updatedTask.assignedTo} not found`, 404),
      );
    }

    const parentWorkShift = assignedParentUser.assignShift;

    for (const depTask of dependentTasks) {
      try {
        const workShift = depTask.assignedTo?.assignShift;
        if (!workShift) continue;

        const parentStart = updatedTask.startDate;
        const parentDue = updatedTask.dueDate;

        if (!parentStart || !parentDue) {
          console.log(`⚠️ Parent dates missing for ${depTask.TaskId}`);
          continue;
        }

        const targetChildDeptId =
          depTask.departmentOfAssignToUser ||
          depTask.assignedTo?._id ||
          depTask.assignedTo;

        const isSameShift =
          String(workShift?._id) === String(parentWorkShift?._id);

        const x = Number(depTask.dependencyConfig?.xValue) || 0;

        const freqStr = (
          depTask.dependencyConfig?.isDependentFrequency || ""
        ).toLowerCase();

        let childStart;
        let childDue;

        // =========================================================
        // CHILD START DATE CALCULATION
        // =========================================================
        const completionTime = new Date(updatedTask.completedAt);
        const childShiftEnd = snapToShiftTime(completionTime, workShift, false);

        if (!isSameShift) {
          console.log("⚠️ Shift mismatch → using child shift calendar");
          const childStartDay = await nextWorkingShiftDate(
            parentStart,
            workShift._id,
            {},
            targetChildDeptId,
          );
          childStart = snapToShiftTime(childStartDay, workShift, true);
        } else {
          if (completionTime >= childShiftEnd) {
            let nextDay = new Date(completionTime);
            nextDay.setDate(nextDay.getDate() + 1);

            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              workShift._id,
              {},
              targetChildDeptId,
            );

            childStart = snapToShiftTime(nextWorkingDay, workShift, true);
          } else {
            childStart = completionTime;
          }
        }

        // =========================================================
        // HOURS DEPENDENCY
        // =========================================================
        if (freqStr.includes("hour")) {
          let remainingMs = x * 60 * 60 * 1000;
          let tempStart = new Date(childStart);
          let tempShiftEnd = snapToShiftTime(tempStart, workShift, false);

          while (remainingMs > 0) {
            const availableMsInShift =
              tempShiftEnd.getTime() - tempStart.getTime();

            if (remainingMs <= availableMsInShift) {
              childDue = new Date(tempStart.getTime() + remainingMs);
              remainingMs = 0;
            } else {
              remainingMs -= Math.max(0, availableMsInShift);

              let nextDay = new Date(tempStart);
              nextDay.setDate(nextDay.getDate() + 1);

              const nextWorkingDay = await nextWorkingShiftDate(
                nextDay,
                workShift._id,
                {},
                targetChildDeptId,
              );

              tempStart = snapToShiftTime(nextWorkingDay, workShift, true);
              tempShiftEnd = snapToShiftTime(nextWorkingDay, workShift, false);
            }
          }

          console.log(
            `⏱️ HOURS dependency | ` +
              `Start: ${childStart.toISOString()} | ` +
              `X: ${x} hrs | ` +
              `Due: ${childDue.toISOString()}`,
          );
        }

        // =========================================================
        // DAYS DEPENDENCY
        // =========================================================
        else {
          const daysToAdd = Math.max(1, x);

          childDue = await addWorkingDaysHoliday(
            childStart,
            daysToAdd,
            workShift._id,
            false,
            {},
            targetChildDeptId,
          );

          const dueIsHoliday = await isHoliday(childDue, targetChildDeptId);
          const dueIsWorkingDay = await isWorkingDay(
            childDue,
            workShift,
            targetChildDeptId,
          );

          if (dueIsHoliday || !dueIsWorkingDay) {
            childDue = await nextWorkingShiftDate(
              childDue,
              workShift._id,
              {},
              targetChildDeptId,
            );
          }

          childDue = snapToShiftTime(childDue, workShift, false);

          console.log(
            `📅 DAYS dependency | ` +
              `Start: ${childStart.toISOString()} | ` +
              `X: ${daysToAdd} days | ` +
              `Due: ${childDue.toISOString()}`,
          );
        }

        // =========================================================
        // 🟢 CALCULATE taskEndDays & taskEndTime
        // =========================================================
        let calculatedTaskEndDays = null;
        let calculatedTaskEndTime = null;

        if (
          childStart &&
          childDue &&
          !isNaN(childStart.getTime()) &&
          !isNaN(childDue.getTime()) &&
          childDue >= childStart
        ) {
          const startDay = new Date(childStart);
          const dueDay = new Date(childDue);

          startDay.setHours(0, 0, 0, 0);
          dueDay.setHours(0, 0, 0, 0);

          const diffMs = dueDay.getTime() - startDay.getTime();
          calculatedTaskEndDays =
            Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;

          calculatedTaskEndTime = `${String(childDue.getHours()).padStart(2, "0")}:${String(
            childDue.getMinutes(),
          ).padStart(2, "0")}`;
        }

        // =========================================================
        // SAVE UPDATED CHILD TASK
        // =========================================================
        const childTask = await Task.findById(depTask._id);

        if (childTask) {
          childTask.startDate = childStart;
          childTask.dueDate = childDue;
          childTask.taskEndDays = calculatedTaskEndDays; // 🟢 Saved
          childTask.taskEndTime = calculatedTaskEndTime; // 🟢 Saved
          childTask.waitingForParent = false;
          childTask.updatedAt = new Date();

          await childTask.save();

          console.log(`✅ Updated dependent task ${depTask.TaskId}`);
          console.log(`   Start: ${childStart.toISOString()}`);
          console.log(`   Due: ${childDue.toISOString()}`);
          console.log(`   taskEndDays: ${calculatedTaskEndDays}`);
          console.log(`   taskEndTime: ${calculatedTaskEndTime}`);
        }
      } catch (err) {
        console.error(`❌ Error updating child task ${depTask.TaskId}:`, err);
      }
    }
  }

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
    const task = await Task.findById(id);
    if (!task) {
      return next(new AppError("Task not found", 404));
    }

    if (task.bucketId) {
      await TaskBucket.findByIdAndUpdate(task.bucketId, {
        $pull: {
          generatedTasks: task._id,
        },
      });
    }

    task.isDeleted = true;
    await task.save();

    const historyDoc = await DeleteTaskHistory.create({
      deleteParentTaskId: task.recurrenceTaskId || null,
      deletedBy: req.cookies?.userId || req.user?._id || null,
      remark: "Soft deleted task",
      deletedTasksCount: 1,
      deletedTaskIds: [task._id],
    });

    res.status(200).json({
      success: true,
      message: "Task deleted successfully",
      deletedCount: 1,
      deletedTaskIds: [task._id],
      historyId: historyDoc._id,
    });
  } catch (err) {
    return next(err);
  }
});

export const deleteParentAndChildren = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const { remark } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError("Invalid ID", 400));
  }

  const parent = await Task.findById(id);
  if (!parent) {
    return next(new AppError("Task not found", 404));
  }

  const toDeleteIds = [parent._id];
  let queue = [parent._id];

  while (queue.length > 0) {
    const children = await Task.find({
      "dependencyConfig.taskDependent": { $in: queue },
    }).select("_id");

    if (!children.length) break;

    const childIds = children.map((c) => c._id);

    const newIds = childIds.filter(
      (cid) => !toDeleteIds.some((existing) => existing.equals(cid)),
    );

    if (!newIds.length) break;

    toDeleteIds.push(...newIds);
    queue = newIds;
  }

  await Task.deleteMany({ _id: { $in: toDeleteIds } });

  if (parent.bucketId) {
    await TaskBucket.updateOne(
      { _id: parent.bucketId },
      { $pull: { generatedTasks: { $in: toDeleteIds } } },
    );
  }

  const historyDoc = await DeleteTaskHistory.create({
    deleteParentTaskId: parent.TaskId || parent._id.toString(),
    deletedBy: req.user?._id || null,
    remark: remark || "",
    deletedTasksCount: toDeleteIds.length,
    deletedTaskIds: toDeleteIds,
  });

  return res.status(200).json({
    success: true,
    message: `Parent task and ${toDeleteIds.length - 1} dependent task(s) deleted`,
    deletedCount: toDeleteIds.length,
    deletedTaskIds: toDeleteIds,
    historyId: historyDoc?._id || null,
  });
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

  if (parts[0] > 1000) {
    [year, month, day] = parts;
  } else {
    const [p1, p2, p3] = parts;

    year = p3;

    if (p2 > 12) {
      day = p2;
      month = p1;
    } else if (p1 > 12) {
      day = p1;
      month = p2;
    } else {
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

  const importLog = [];
  const validTasks = [];
  let rows = [];
  let rowCount = 0;

  try {
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

    const headers = Object.keys(rows[0] || {}).map((h) => String(h).trim());
    const normalize = (s) =>
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    const normalized = headers.map(normalize);

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

    let detected = "delegation";
    if (normalized.includes("taskid")) detected = "dependent";
    else if (normalized.includes("frequency") && normalized.includes("enddate"))
      detected = "recurring";

    const missing = required[detected].filter((h) => !normalized.includes(h));
    if (missing.length > 0) {
      const suspects = headers.filter((h) =>
        missing.some(
          (m) =>
            h.toLowerCase().includes(m.replace(/([a-z])([A-Z])/g, "$1 $2")) ||
            m.includes(h.toLowerCase().replace(/[^a-z0-9]/g, "")),
        ),
      );
      fs.unlinkSync(filePath);
      return next(
        new AppError(
          `Missing required column(s) for ${detected} import: ${missing.join(", ")}. Please use exact header names.${suspects.length ? " Suspect headers: " + suspects.join(", ") : ""}`,
          400,
        ),
      );
    }

    for (const row of rows) {
      rowCount++;

      try {
        const {
          "Task Title": title,
          "Task Description": description,
          "Assign To(Email)": assignToEmail,
          "Assign To(Name)": assignToName,
          "Assign To UserDepartment": departmentName,
          "Start Date": startDateStr,
          "Due Date": dueDateStr,
          "Task End Days": taskEndDaysStr,
          isDependent: isDependentStr,
          "Attachment File": attachmentFile,
          "Check List": checkListStr,
          Frequency: frequency,
          "Task ID": parentTaskId,
          "Start Time Setting": startTimeSetting,
          "X Value": xValue,
          "End Date": endDateStr,
          "Week Days": weekDaysStr,
        } = row;

        const trimStr = (v) => (v ? String(v).trim() : "");

        const trimmedStartDateStr = trimStr(startDateStr);
        const trimmedTaskEndDays = trimStr(taskEndDaysStr);
        const trimmedDueDateStr = trimStr(dueDateStr);
        const trimmedEndDateStr = trimStr(endDateStr);
        const trimmedIsDependentStr = trimStr(isDependentStr);
        const trimmedParentTaskId = trimStr(parentTaskId);
        const trimmedStartTimeSetting = trimStr(startTimeSetting);
        const trimmedXValue = trimStr(xValue);
        const trimmedFrequency = trimStr(frequency);

        const weekDaysArr = weekDaysStr
          ? String(weekDaysStr)
              .split(",")
              .map((d) => d.trim().toLowerCase())
              .filter(Boolean)
          : [];

        if (!title || !description || !assignToEmail || !departmentName) {
          throw new Error(
            "Missing required fields: Task Title, Task Description, Assign To(Email), Assign To UserDepartment.",
          );
        }

        const assignToEmails = assignToEmail
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
        const assignToNames = assignToName
          ? String(assignToName)
              .split(",")
              .map((n) => n.trim())
              .filter(Boolean)
          : [];
        const departmentNames = departmentName
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);

        if (assignToEmails.length === 0) {
          throw new Error('At least one "Assign To(Email)" is required.');
        }
        if (
          assignToNames.length > 0 &&
          assignToNames.length !== assignToEmails.length
        ) {
          throw new Error(
            "Assign To(Name) count must match Assign To(Email) count.",
          );
        }

        const usersForThisRow = [];

        if (assignToEmails.length === 1 && departmentNames.length >= 1) {
          const query = { email: assignToEmails[0] };
          if (assignToNames[0]) query.name = assignToNames[0];

          const user = await User.findOne(query);
          if (!user) throw new Error(`User "${assignToEmails[0]}" not found.`);

          for (const deptName of departmentNames) {
            const department = await Department.findOne({
              name: { $regex: `^${deptName}$`, $options: "i" },
            });
            if (!department)
              throw new Error(`Department "${deptName}" not found.`);

            const belongs =
              Array.isArray(user.department) &&
              user.department.some(
                (id) => id.toString() === department._id.toString(),
              );
            if (!belongs)
              throw new Error(
                `User "${assignToEmails[0]}" does not belong to "${deptName}".`,
              );

            usersForThisRow.push({
              user,
              departmentId: department._id,
              departmentName: deptName,
            });
          }
        } else {
          if (assignToEmails.length !== departmentNames.length) {
            throw new Error(
              "When using multiple users, department count must match user count.",
            );
          }
          for (let i = 0; i < assignToEmails.length; i++) {
            const deptName = departmentNames[i];
            const department = await Department.findOne({
              name: { $regex: `^${deptName}$`, $options: "i" },
            });
            if (!department)
              throw new Error(`Department "${deptName}" not found.`);

            const query = { email: assignToEmails[i] };
            if (assignToNames[i]) query.name = assignToNames[i];

            const user = await User.findOne(query);
            if (!user)
              throw new Error(`User "${assignToEmails[i]}" not found.`);

            const belongs =
              Array.isArray(user.department) &&
              user.department.some(
                (id) => id.toString() === department._id.toString(),
              );
            if (!belongs)
              throw new Error(
                `User "${assignToEmails[i]}" does not belong to "${deptName}".`,
              );

            usersForThisRow.push({
              user,
              departmentId: department._id,
              departmentName: deptName,
            });
          }
        }

        const isDependent =
          trimmedIsDependentStr.toLowerCase() === "true" ||
          Boolean(trimmedParentTaskId);
        const isRecurrent = detected === "recurring";

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

        if (startDate && taskEndDays) {
          dueDate = new Date(startDate);
          dueDate.setDate(dueDate.getDate() + Number(taskEndDays));
        }

        if (!isDependent && !isRecurrent) {
          if (!taskEndDays || isNaN(taskEndDays)) {
            throw new Error(
              "Task End Days must be a valid number for delegation tasks.",
            );
          }
        }
        if (!isDependent && !startDate) {
          throw new Error(
            "Start Date is required for delegation and recurring tasks.",
          );
        }
        if (isDependent && trimmedStartDateStr && !startDate) {
          throw new Error(
            "Invalid Start Date format. Use DD-MM-YYYY or YYYY-MM-DD.",
          );
        }

        let depFreqNormalized = null;
        if (isDependent) {
          if (!trimmedFrequency)
            throw new Error(
              'Frequency is required for dependent tasks. Use "T+X in days" or "T+X in hours".',
            );
          const f = trimmedFrequency.toLowerCase();
          if (/t\+x\s*.*days|t\+xdays/i.test(f))
            depFreqNormalized = "T+X in days";
          else if (/t\+x\s*.*hours|t-?x\s*.*hours|t\+xhours/i.test(f))
            depFreqNormalized = "T-X in hours";
          else
            throw new Error(
              `Invalid Frequency "${trimmedFrequency}". Allowed: "T+X in days" or "T+X in hours".`,
            );
        }

        let finalAttachmentPath = null;
        if (attachmentFile) {
          const attachmentPath = path.join(
            process.cwd(),
            "uploads",
            String(attachmentFile).trim(),
          );
          if (!fs.existsSync(attachmentPath)) {
            throw new Error(
              `Attachment file "${attachmentFile}" not found in uploads directory.`,
            );
          }
          finalAttachmentPath = String(attachmentFile).trim();
        }

        const checklist = checkListStr
          ? String(checkListStr)
              .split(",")
              .map((item) => ({ text: item.trim() }))
          : [];

        const rowCreated = [];

        for (const item of usersForThisRow) {
          const { user, departmentId, departmentName: deptLabel } = item;

          if (startDate) {
            const existingTask = await Task.findOne({
              title: title.trim(),
              assignedTo: user._id,
              startDate: {
                $gte: startOfDay(startDate),
                $lt: startOfDay(new Date(startDate.getTime() + 86400000)),
              },
            });
            if (existingTask) {
              importLog.push({
                row: rowCount,
                status: "skipped",
                reason: `Duplicate: task "${title.trim()}" for ${user.email} on same start date already exists.`,
                user: user.email,
                department: deptLabel,
                taskTitle: title.trim(),
              });
              continue;
            }
          }

          const taskData = {
            title: title.trim(),
            description: description.trim(),
            assignedTo: user._id,
            assignedBy: req.user._id,
            createdBy: req.user._id,
            startDate,
            dueDate,
            taskEndDays,
            attachmentFile: finalAttachmentPath,
            isDependent,
            departmentOfAssignToUser: departmentId,
            checklist,
          };

          let taskInstance;

          if (isDependent) {
            const parentTask = await Task.findOne({
              TaskId: trimmedParentTaskId,
            });
            if (!parentTask)
              throw new Error(
                `Parent task ID "${trimmedParentTaskId}" not found.`,
              );

            const parentEnd =
              parentTask.dueDate || parentTask.endDate || parentTask.startDate;
            if (!parentEnd) throw new Error("Parent task has no valid date.");

            const x = Number(trimmedXValue) || 0;
            const freq = (trimmedFrequency || "").toLowerCase();

            let calcStart = new Date(parentEnd);
            if (freq.includes("hour"))
              calcStart.setHours(calcStart.getHours() + x);
            else calcStart.setDate(calcStart.getDate() + x);

            startDate = calcStart;
            if (taskEndDays && !isNaN(taskEndDays)) {
              dueDate = new Date(startDate);
              dueDate.setDate(dueDate.getDate() + Number(taskEndDays));
            }

            const existingDep = await Task.findOne({
              title: title.trim(),
              assignedTo: user._id,
              "dependencyConfig.taskDependent": parentTask._id,
            });
            if (existingDep) {
              importLog.push({
                row: rowCount,
                status: "skipped",
                reason: `Duplicate dependent task for ${user.email} linked to parent ${trimmedParentTaskId}.`,
                user: user.email,
                department: deptLabel,
                taskTitle: title.trim(),
              });
              continue;
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
            taskInstance = new RecurringTask({
              ...taskData,
              endDate,
              weekDays: weekDaysArr,
              frequency: trimmedFrequency,
            });
          } else {
            taskInstance = new DelegationTask(taskData);
          }

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
          rowCreated.push({
            user: user.email,
            department: deptLabel,
            taskId: taskInstance.TaskId,
          });
        }

        rowCreated.forEach(({ user: email, department: dept, taskId }) => {
          importLog.push({
            row: rowCount,
            status: "imported",
            reason: "OK",
            user: email,
            department: dept,
            taskTitle: title.trim(),
            taskId,
          });
        });
      } catch (rowError) {
        importLog.push({
          row: rowCount,
          status: "error",
          reason: rowError.message,
          user: row["Assign To(Email)"] || "",
          department: row["Assign To UserDepartment"] || "",
          taskTitle: row["Task Title"] || "",
          taskId: null,
        });
      }
    }

    let insertedCount = 0;
    if (validTasks.length > 0) {
      await Task.insertMany(validTasks);
      insertedCount = validTasks.length;
    }

    const importedRows = importLog.filter((l) => l.status === "imported");
    const skippedRows = importLog.filter((l) => l.status === "skipped");
    const errorRows = importLog.filter((l) => l.status === "error");

    let errorFile = null;
    const failedRows = [...skippedRows, ...errorRows];
    if (failedRows.length > 0) {
      const parser = new Parser({
        fields: [
          "row",
          "status",
          "reason",
          "user",
          "department",
          "taskTitle",
          "taskId",
        ],
      });
      const csvContent = parser.parse(failedRows);
      const errorFileName = `${Date.now()}-import-errors.csv`;
      const errorFilePath = path.join(process.cwd(), "uploads", errorFileName);
      fs.writeFileSync(errorFilePath, csvContent);
      errorFile = errorFileName;
    }

    return res.status(200).json({
      success: insertedCount > 0,
      message:
        insertedCount > 0
          ? `Import complete. ${insertedCount} task(s) created across ${importedRows.length} row(s).`
          : "No tasks were imported. All rows had errors or duplicates.",
      summary: {
        totalRows: rowCount,
        imported: importedRows.length,
        skipped: skippedRows.length,
        errors: errorRows.length,
      },
      log: importLog,
      errorFile,
    });
  } catch (topLevelError) {
    return next(new AppError(topLevelError.message, 500));
  } finally {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error deleting uploaded file ${filePath}:`, err);
    });
  }
});

// ---------------------------------------------------------
// FINAL MERGED UPDATE TASK CONTROLLER
// ---------------------------------------------------------
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

const applyTaskEndTime = (date, taskEndTime) => {
  if (!date || !taskEndTime) return date;

  const [hours, minutes] = taskEndTime.split(":").map(Number);

  date.setHours(hours, minutes, 0, 0);

  return date;
};

// =========================================================
// ✅ UPDATE TASK CONTROLLER
// =========================================================
export const updateTask = handleAsync(async (req, res, next) => {
  const { id } = req.params;

  let shouldRecalculateStatus = false;

  const task = await Task.findById(id);

  if (!task) {
    return next(new AppError("Task not found", 404));
  }

  const oldData = task.toObject();

  const {
    isRecurrent,
    parentTask,
    startTimeSetting,
    isDependentFrequency,
    xValue,
    assignedTo,
    departmentOfAssignToUser,
    checklist,
    startDate,
    dueDate,
    frequency,
    endDate,
    weekDays,
    status,
    taskEndDays,
    taskEndTime,
    ...otherUpdates
  } = req.body;

  Object.assign(task, otherUpdates);

  if (status !== undefined) {
    task.status = status;
  }

  const oldAssignedTo = task.assignedTo?.toString();
  const isAssigneeOrDeptChanged =
    (assignedTo && oldAssignedTo !== assignedTo.toString()) ||
    (departmentOfAssignToUser &&
      task.departmentOfAssignToUser?.toString() !==
        departmentOfAssignToUser.toString());

  if (assignedTo) {
    task.assignedTo = assignedTo;
  }

  // 🟢 1. UPDATE DEPARTMENT REFERENCE
  if (departmentOfAssignToUser) {
    task.departmentOfAssignToUser = departmentOfAssignToUser;
  }

  // =========================================================
  // FILES
  // =========================================================
  let existingFiles = [];
  let removedFiles = [];

  try {
    existingFiles = JSON.parse(req.body.existingFiles || "[]");
    removedFiles = JSON.parse(req.body.removedFiles || "[]");
  } catch (err) {
    console.error("Error parsing file arrays:", err);
  }

  removedFiles.forEach((filePath) => {
    const fullPath = path.join(process.cwd(), "uploads", filePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  });

  const newFiles = req.files
    ? req.files.map((file) => `${req.uploadFolder}/${file.filename}`)
    : [];

  task.attachmentFile = [...existingFiles, ...newFiles];
  task.updatedBy = req.user._id;

  if (otherUpdates.isDependent !== undefined) {
    task.isDependent =
      otherUpdates.isDependent === "true" || otherUpdates.isDependent === true;
  }

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

  const hasStartDate = startDate !== undefined && cleanField(startDate);
  const hasDueDate = dueDate !== undefined && cleanField(dueDate);
  const hasTaskEndDays = taskEndDays !== undefined;
  const hasTaskEndTime = taskEndTime !== undefined;

  const currentAssignedTo = assignedTo || task.assignedTo;
  const targetDeptId =
    departmentOfAssignToUser ||
    task.departmentOfAssignToUser ||
    currentAssignedTo;

  let assignedUser = null;
  let workShift = null;

  if (currentAssignedTo) {
    assignedUser =
      await User.findById(currentAssignedTo).populate("assignShift");

    if (!assignedUser) {
      return next(
        new AppError(`User with ID ${currentAssignedTo} not found`, 404),
      );
    }

    workShift = assignedUser.assignShift;

    if (!workShift) {
      return next(
        new AppError(`No workshift assigned to user ${assignedUser.name}`, 400),
      );
    }
  }

  // 🟢 2. REASSIGNMENT DATES RECALCULATION LOGIC
  if (isAssigneeOrDeptChanged && !hasStartDate && !hasDueDate) {
    const now = new Date();

    // Recalculate Start Date aligned with new assignee's shift/calendar
    const nextValidStart = await nextWorkingShiftDate(
      now,
      workShift._id,
      {},
      targetDeptId,
    );

    task.startDate = snapToShiftTime(nextValidStart, workShift, true);

    // Recalculate Due Date based on taskEndDays or existing duration
    const currentEndDays =
      hasTaskEndDays && Number(taskEndDays) > 0
        ? Number(taskEndDays)
        : Number(task.taskEndDays) || 1;

    task.taskEndDays = currentEndDays;

    task.dueDate = await addWorkingDaysHoliday(
      task.startDate,
      currentEndDays,
      workShift._id,
      false,
      {},
      targetDeptId,
    );

    if (task.taskEndTime) {
      const [hours, minutes] = String(task.taskEndTime).split(":").map(Number);
      if (Number.isFinite(hours) && Number.isFinite(minutes)) {
        task.dueDate.setHours(hours, minutes, 0, 0);
      }
    } else {
      task.dueDate = snapToShiftTime(task.dueDate, workShift, false);
    }
  }

  // Explicit Start Date Update
  if (hasStartDate) {
    const parsedStartDate = parseDateIST(startDate);
    if (!parsedStartDate) {
      return next(new AppError("Invalid start date", 400));
    }

    task.startDate = await nextWorkingShiftDate(
      parsedStartDate,
      workShift._id,
      {},
      targetDeptId,
    );
  }

  // Explicit Task End Days Update
  if (hasTaskEndDays) {
    if (
      taskEndDays === null ||
      taskEndDays === "" ||
      String(taskEndDays).trim() === ""
    ) {
      task.taskEndDays = null;
    } else {
      const parsedEndDays = Number(taskEndDays);
      if (!Number.isFinite(parsedEndDays) || parsedEndDays < 0) {
        return next(
          new AppError("taskEndDays must be a valid positive number", 400),
        );
      }
      task.taskEndDays = parsedEndDays;
    }
  }

  if (hasTaskEndTime) {
    task.taskEndTime = cleanField(taskEndTime);
  }

  // 🟢 3. DUE DATE CALCULATION FOR DELEGATION TASKS
  if (task.taskType === "DelegationTask" && !isAssigneeOrDeptChanged) {
    const hasValidTaskEndDays =
      task.taskEndDays !== null &&
      task.taskEndDays !== undefined &&
      String(task.taskEndDays).trim() !== "" &&
      Number.isFinite(Number(task.taskEndDays));

    const applyTaskEndTimeToDueDate = () => {
      if (!task.dueDate || !task.taskEndTime) return;

      const timeValue = String(task.taskEndTime).trim();
      const match = timeValue.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

      if (!match) return;

      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3] || 0);

      if (
        hours < 0 ||
        hours > 23 ||
        minutes < 0 ||
        minutes > 59 ||
        seconds < 0 ||
        seconds > 59
      ) {
        return;
      }

      const updatedDueDate = new Date(task.dueDate);
      updatedDueDate.setHours(hours, minutes, seconds, 0);
      task.dueDate = updatedDueDate;
    };

    if (hasStartDate || hasTaskEndDays) {
      if (hasValidTaskEndDays) {
        task.dueDate = await addWorkingDaysHoliday(
          task.startDate,
          Number(task.taskEndDays),
          workShift._id,
          false,
          {},
          targetDeptId,
        );
        applyTaskEndTimeToDueDate();
      } else if (hasDueDate) {
        const parsedDueDate = parseDateIST(dueDate);
        if (!parsedDueDate) {
          return next(new AppError("Invalid due date", 400));
        }

        task.dueDate = await nextWorkingShiftDate(
          parsedDueDate,
          workShift._id,
          {},
          targetDeptId,
        );

        if (task.taskEndTime) {
          applyTaskEndTimeToDueDate();
        } else {
          task.dueDate.setHours(
            parsedDueDate.getHours(),
            parsedDueDate.getMinutes(),
            parsedDueDate.getSeconds(),
            parsedDueDate.getMilliseconds(),
          );
        }
      }
    } else if (hasDueDate) {
      const parsedDueDate = parseDateIST(dueDate);
      if (!parsedDueDate) {
        return next(new AppError("Invalid due date", 400));
      }

      task.dueDate = await nextWorkingShiftDate(
        parsedDueDate,
        workShift._id,
        {},
        targetDeptId,
      );

      if (task.taskEndTime) {
        applyTaskEndTimeToDueDate();
      } else {
        task.dueDate.setHours(
          parsedDueDate.getHours(),
          parsedDueDate.getMinutes(),
          parsedDueDate.getSeconds(),
          parsedDueDate.getMilliseconds(),
        );
      }
    } else if (hasTaskEndTime && task.dueDate) {
      applyTaskEndTimeToDueDate();
    }
  }

  // Recurring Tasks Logic
  if (task.taskType === "RecurringTask") {
    const recurringAssignedUser = await User.findById(task.assignedTo).populate(
      "assignShift",
    );

    if (!recurringAssignedUser) {
      return next(
        new AppError(`User with ID ${task.assignedTo} not found`, 404),
      );
    }

    const recurringWorkShift = recurringAssignedUser.assignShift;

    if (!recurringWorkShift) {
      return next(
        new AppError(
          `No workshift assigned to user ${recurringAssignedUser.name}`,
          400,
        ),
      );
    }

    if (frequency !== undefined) {
      task.frequency = cleanField(frequency);
    }

    if (endDate !== undefined) {
      const cleanedEndDate = cleanField(endDate);
      if (!cleanedEndDate) {
        task.endDate = null;
      } else {
        const selectedEndDate = parseDateIST(cleanedEndDate);
        if (!selectedEndDate) {
          return next(new AppError("Invalid recurring end date", 400));
        }
        task.endDate = selectedEndDate;
      }
    }

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

  const updatedTask = await task.save();

  if (
    task.taskType === "RecurringTask" &&
    assignedTo &&
    oldAssignedTo !== assignedTo.toString()
  ) {
    await updateRecurringGeneratedTaskAssignee({
      recurringTaskId: task._id,
      assignedTo,
      updatedBy: req.user._id,
    });
  }

  await createLog({
    action: "UPDATE",
    module: "TASK",
    documentId: task._id,
    performedBy: req.cookies.userId || req.user._id || null,
    oldData,
    newData: task,
    message: `Task Updated | Title: ${task.title} | ID: ${task.TaskId}`,
  });

  const justCompleted =
    status === "Completed" && oldData.status !== "Completed";

  if (justCompleted) {
    const dependentTasks = await Task.find({
      "dependencyConfig.taskDependent": task._id,
      "dependencyConfig.startTimeSetting": "actual-to-planned",
      waitingForParent: true,
    }).populate({
      path: "assignedTo",
      populate: { path: "assignShift" },
    });

    for (const depTask of dependentTasks) {
      try {
        const childWorkShift = depTask.assignedTo.assignShift;
        if (!childWorkShift) continue;

        const x = Number(depTask.dependencyConfig.xValue || 0);
        const freqStr = (
          depTask.dependencyConfig.isDependentFrequency || ""
        ).toLowerCase();
        const baseDate = new Date(task.completedAt);

        let newStartDate;
        const targetChildDeptId =
          depTask.departmentOfAssignToUser ||
          depTask.assignedTo._id ||
          depTask.assignedTo;

        if (freqStr.includes("hour")) {
          let calculatedDate = new Date(baseDate);
          calculatedDate.setHours(calculatedDate.getHours() + x);

          const shiftStart = snapToShiftTime(
            calculatedDate,
            childWorkShift,
            true,
          );
          const shiftEnd = snapToShiftTime(
            calculatedDate,
            childWorkShift,
            false,
          );

          if (calculatedDate < shiftStart) {
            newStartDate = shiftStart;
          } else if (calculatedDate >= shiftEnd) {
            const nextDay = new Date(calculatedDate);
            nextDay.setDate(nextDay.getDate() + 1);

            newStartDate = await nextWorkingShiftDate(
              nextDay,
              childWorkShift._id,
              {},
              targetChildDeptId,
            );
          } else {
            newStartDate = calculatedDate;
          }
        } else {
          let plannedDate = await addWorkingDaysHoliday(
            baseDate,
            x,
            childWorkShift._id,
            false,
            {},
            targetChildDeptId,
          );

          plannedDate.setHours(
            baseDate.getHours(),
            baseDate.getMinutes(),
            baseDate.getSeconds(),
            baseDate.getMilliseconds(),
          );

          const shiftStart = snapToShiftTime(plannedDate, childWorkShift, true);
          const shiftEnd = snapToShiftTime(plannedDate, childWorkShift, false);

          if (plannedDate < shiftStart) {
            plannedDate = shiftStart;
          } else if (plannedDate >= shiftEnd) {
            const nextDay = new Date(plannedDate);
            nextDay.setDate(nextDay.getDate() + 1);

            plannedDate = await nextWorkingShiftDate(
              nextDay,
              childWorkShift._id,
              {},
              targetChildDeptId,
            );
          }

          newStartDate = plannedDate;
        }

        let newDueDate = null;
        const taskDays = Number(depTask.taskEndDays);

        if (!isNaN(taskDays) && taskDays > 0) {
          newDueDate = await addWorkingDaysHoliday(
            newStartDate,
            taskDays,
            childWorkShift._id,
            false,
            {},
            targetChildDeptId,
          );

          if (depTask.taskEndTime) {
            const [hours, minutes] = String(depTask.taskEndTime)
              .split(":")
              .map(Number);

            if (Number.isFinite(hours) && Number.isFinite(minutes)) {
              newDueDate.setHours(hours, minutes, 0, 0);
            }
          } else {
            newDueDate = snapToShiftTime(newDueDate, childWorkShift, false);
          }
        }

        const childTask = await Task.findById(depTask._id);
        if (childTask) {
          childTask.startDate = newStartDate;
          childTask.dueDate = newDueDate;
          childTask.waitingForParent = false;
          childTask.updatedAt = new Date();

          await childTask.save();
        }
      } catch (err) {
        console.error("❌ Error updating child task:", err);
      }
    }
  }

  await updatedTask.populate("assignedTo");

  res.status(200).json({
    success: true,
    data: normalizeTask(updatedTask),
  });
});

export const updateRecurringGeneratedTaskAssignee = async ({
  recurringTaskId,
  assignedTo,
  updatedBy,
}) => {
  try {
    if (!recurringTaskId || !assignedTo) return;

    const assignedUser =
      await User.findById(assignedTo).populate("assignShift");

    const generatedTasks = await Task.find({
      recurrenceTaskId: recurringTaskId,
      taskType: "DelegationTask",
      status: { $ne: "Completed" },
    });
    console.log("generatedTasks", generatedTasks);
    console.log(
      `🔁 Updating ${generatedTasks.length} recurring generated tasks`,
    );

    for (const task of generatedTasks) {
      task.assignedTo = assignedTo;

      task.updatedBy = updatedBy;
      task.updatedAt = new Date();

      await task.save();
    }

    console.log(`✅ Successfully updated generated recurring tasks`);
  } catch (error) {
    console.error("❌ updateRecurringGeneratedTaskAssignee Error:", error);
  }
};
