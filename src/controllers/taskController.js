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
      // startDate: effectiveStartDate,
      // dueDate: effectiveDueDate,
      departmentOfAssignToUser: deptId,
      checklist: parsedChecklist,
      // currentHolder: delegationFlowEnabled ? assignedTo : assignedTo,

      // delegationFlowEnabled,

      // distributionStatus: delegationFlowEnabled
      //   ? "Awaiting Distribution"
      //   : "Assigned",
    };

    // 🔥 DEPENDENT PLANNED-TO-PLANNED (WorkShift Aware)
    //**GLOBAL CHANGE */
    // if (
    //   isDep &&
    //   dependencyData.taskDependent &&
    //   dependencyData.startTimeSetting === "planned-to-planned"
    // ) {
    //   try {
    //     let parent = null;
    //     if (mongoose.Types.ObjectId.isValid(dependencyData.taskDependent)) {
    //       parent = await Task.findById(dependencyData.taskDependent).lean();
    //     }
    //     if (!parent) {
    //       parent = await Task.findOne({
    //         TaskId: String(dependencyData.taskDependent),
    //       }).lean();
    //     }

    //     if (parent) {
    //       const parentEnd =
    //         parent.dueDate || parent.endDate || parent.startDate;
    //       if (!parentEnd) return;

    //       const x = Number(dependencyData.xValue) || 0;
    //       const freqStr = (
    //         dependencyData.isDependentFrequency || ""
    //       ).toLowerCase();

    //       // 🔹 Step 1: Use only parent DATE
    //       // 🔹 Step 1: Use parent planned end date WITH TIME
    //       const parentDate = new Date(parentEnd);

    //       let newStartDate;

    //       // ======================
    //       // HOURS
    //       // ======================
    //       if (freqStr.includes("hour")) {
    //         let calculatedDate = new Date(parentDate);

    //         calculatedDate.setHours(calculatedDate.getHours() + x);

    //         const shiftStart = snapToShiftTime(calculatedDate, workShift, true);

    //         const shiftEnd = snapToShiftTime(calculatedDate, workShift, false);

    //         if (calculatedDate < shiftStart) {
    //           newStartDate = shiftStart;
    //         } else if (calculatedDate >= shiftEnd) {
    //           const nextDay = new Date(calculatedDate);
    //           nextDay.setDate(nextDay.getDate() + 1);

    //           newStartDate = await nextWorkingShiftDate(nextDay, workShift._id);
    //         } else {
    //           newStartDate = calculatedDate;
    //         }
    //       }

    //       // ======================
    //       // DAYS
    //       // ======================
    //       else {
    //         let plannedDate = await addWorkingDaysHoliday(
    //           parentDate,
    //           x,
    //           workShift._id,
    //         );

    //         // preserve parent's time
    //         plannedDate.setHours(
    //           parentDate.getHours(),
    //           parentDate.getMinutes(),
    //           parentDate.getSeconds(),
    //           parentDate.getMilliseconds(),
    //         );

    //         const shiftStart = snapToShiftTime(plannedDate, workShift, true);

    //         const shiftEnd = snapToShiftTime(plannedDate, workShift, false);

    //         if (plannedDate < shiftStart) {
    //           plannedDate = shiftStart;
    //         } else if (plannedDate >= shiftEnd) {
    //           const nextDay = new Date(plannedDate);
    //           nextDay.setDate(nextDay.getDate() + 1);

    //           plannedDate = await nextWorkingShiftDate(nextDay, workShift._id);
    //         }

    //         newStartDate = plannedDate;
    //       }

    //       commonFields.startDate = newStartDate;

    //       // 🔹 Step 3: Compute dueDate if taskEndDays exist
    //       if (parsedTaskEndDays) {
    //         commonFields.dueDate = await addWorkingDaysHoliday(
    //           commonFields.startDate,
    //           parsedTaskEndDays,
    //           workShift._id,
    //         );

    //         commonFields.dueDate = snapToShiftTime(
    //           commonFields.dueDate,
    //           workShift,
    //           false,
    //         );
    //       }
    //     } else {
    //       console.log("❌ No parent task found");
    //     }
    //   } catch (err) {
    //     console.error("Error computing dependent dates:", err);
    //   }
    // }
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
        if (parent) {
          const parentStart = parent.startDate;
          const parentDue = parent.dueDate;

          if (!parentStart || !parentDue) {
            console.log("❌ Parent dates missing");
            return;
          }
          if (!isSameShift) {
            console.log("⚠️ Shift mismatch → using child shift calendar");

            const childStartDay = await nextWorkingShiftDate(
              parentStart,
              workShift._id,
            );

            const childStart = snapToShiftTime(childStartDay, workShift, true);

            commonFields.startDate = childStart;

            let dueDate = new Date(childStart);

            const x = Number(dependencyData.xValue) || 0;
            const freqStr = (
              dependencyData.isDependentFrequency || ""
            ).toLowerCase();

            // ======================
            // HOURS
            // ======================
            if (freqStr.includes("hour")) {
              let calculatedDue = new Date(childStart);

              // add x hours from child shift start
              calculatedDue.setHours(calculatedDue.getHours() + x);

              const shiftEnd = snapToShiftTime(childStart, workShift, false);

              if (calculatedDue < shiftEnd) {
                dueDate = calculatedDue;
              } else {
                const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();

                let nextDay = new Date(childStart);
                nextDay.setDate(nextDay.getDate() + 1);

                let nextWorkingDay = await nextWorkingShiftDate(
                  nextDay,
                  workShift._id,
                );

                const nextShiftStart = snapToShiftTime(
                  nextWorkingDay,
                  workShift,
                  true,
                );

                dueDate = new Date(nextShiftStart.getTime() + overflowMs);
              }
            }

            // ======================
            // DAYS
            // ======================
            else {
              dueDate = await addWorkingDaysHoliday(
                childStart,
                x,
                workShift._id,
              );

              const shiftEnd = snapToShiftTime(dueDate, workShift, false);
              dueDate.setHours(
                shiftEnd.getHours(),
                shiftEnd.getMinutes(),
                shiftEnd.getSeconds(),
                shiftEnd.getMilliseconds(),
              );

              if (dueDate >= shiftEnd) {
                let nextDay = new Date(dueDate);
                nextDay.setDate(nextDay.getDate() + 1);

                let nextWorkingDay = await nextWorkingShiftDate(
                  nextDay,
                  workShift._id,
                );

                dueDate = snapToShiftTime(nextWorkingDay, workShift, false);
              }
            }

            commonFields.dueDate = dueDate;
          } else {
            // Child start = Parent start
            commonFields.startDate = new Date(parentStart);

            let dueDate = new Date(parentDue);

            const x = Number(dependencyData.xValue) || 0;
            const freqStr = (
              dependencyData.isDependentFrequency || ""
            ).toLowerCase();

            // ======================
            // HOURS
            // ======================
            if (freqStr.includes("hour")) {
              let calculatedDue = new Date(parentDue);

              // add x hours to parent due
              calculatedDue.setHours(calculatedDue.getHours() + x);
              const shiftEnd = snapToShiftTime(parentDue, workShift, false);

              // if within shift, keep it
              if (calculatedDue < shiftEnd) {
                dueDate = calculatedDue;
              } else {
                // overflow beyond shift end
                const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();

                let nextDay = new Date(parentDue);
                nextDay.setDate(nextDay.getDate() + 1);

                let nextWorkingDay = await nextWorkingShiftDate(
                  nextDay,
                  workShift._id,
                );

                const nextShiftStart = snapToShiftTime(
                  nextWorkingDay,
                  workShift,
                  true,
                );

                // next shift start + overflow
                dueDate = new Date(nextShiftStart.getTime() + overflowMs);
              }
            }

            // ======================
            // DAYS
            // ======================
            else {
              dueDate = await addWorkingDaysHoliday(
                parentDue,
                x,
                workShift._id,
              );

              dueDate.setHours(
                parentDue.getHours(),
                parentDue.getMinutes(),
                parentDue.getSeconds(),
                parentDue.getMilliseconds(),
              );

              const shiftEnd = snapToShiftTime(dueDate, workShift, false);

              if (dueDate >= shiftEnd) {
                let nextDay = new Date(dueDate);
                nextDay.setDate(nextDay.getDate() + 1);

                let nextWorkingDay = await nextWorkingShiftDate(
                  nextDay,
                  workShift._id,
                );

                dueDate = snapToShiftTime(nextWorkingDay, workShift, false);
              }
            }
            commonFields.dueDate = dueDate;
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
      let recurrenceEnd = recurrenceEndDate;
      //**comment for new change now endtime also be stored with end date in recurring task */
      // if (cleanField(recurrenceEndDate)) {
      //   recurrenceEnd = await nextWorkingShiftDate(
      //     parseDateIST(recurrenceEndDate),
      //     workShift._id,
      //   );

      //   recurrenceEnd = snapToShiftTime(
      //     recurrenceEnd,
      //     workShift,
      //     false, // shift end time
      //   );
      // }
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
      // 🔥 DELEGATION
      newTask = new DelegationTask({
        ...commonFields,
        taskEndTime,
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
    // if (delegationFlowEnabled) {
    //   await TaskDelegationFlow.create({
    //     taskId: newTask._id,
    //     level: 1,
    //     fromUser: userId,
    //     toUser: assignedTo,
    //     actionType: "Created",
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
    const statusCounts = {
      Pending: allTasks.filter((t) => t.status === "Pending").length,
      Completed: allTasks.filter((t) => t.status === "Completed").length,
      Delayed: allTasks.filter((t) => t.status === "Delayed").length,
      Upcoming: allTasks.filter((t) => t.status === "Upcoming").length,
      Overdue: allTasks.filter((t) => {
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
      total: allTasks.length,
      counts: statusCounts,
      data: allTasks,
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
const getNextWorkingDate = async (date, workShift) => {
  let adjustedDate = startOfDay(date);

  while (true) {
    const holiday = await isHoliday(adjustedDate);

    const working = workShift && isWorkingDay(adjustedDate, workShift);

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
  // Validate dates if provided
  // if (startDate && !startDate.match(/^\\d{4}-\\d{2}-\\d{2}$/)) {
  //   console.log(startDate)
  //   return res.status(400).json({ success: false, message: "startDate must be YYYY-MM-DD" });
  // }
  // if (endDate && !endDate.match(/^\\d{4}-\\d{2}-\\d{2}$/)) {
  //   return res.status(400).json({ success: false, message: "endDate must be YYYY-MM-DD" });
  // }

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
    // ONLY generated recurring delegation tasks
    query.taskType = "DelegationTask";

    query.frequency = {
      $exists: true,
      $ne: null,
    };
  } else if (taskType === "DelegationTask") {
    // ONLY normal delegation tasks
    query.taskType = "DelegationTask";

    query.$or = [{ frequency: { $exists: false } }, { frequency: null }];
  } else if (taskType === "All") {
    //this is for task reassigning page
    // Show both recurring + normal delegation tasks
    query.taskType = "DelegationTask";
  } else if (taskType === "recurring") {
    //this is for task reassigning page
    // Show both recurring + normal delegation tasks
    query.taskType = "RecurringTask";
  } else {
    // hide recurring templates
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
  // 🔥 visibility filter
  if (query.status !== "Upcoming" && taskType !== "All") {
    andConditions.push({
      isVisible: true,
    });
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
      // BI-WEEKLY
      // ==================================================
      else if (template.frequency === "Bi-weekly") {
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

          // First occurrence
          if (currentIndex === startIndex) {
            isValid = true;
          }
          // Second occurrence (can fall into next week)
          else {
            const secondIndex = (startIndex + repeatAfter) % 7;
            isValid = currentIndex === secondIndex;
          }
        }
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

      const isHolidayDate = await isHoliday(date);

      const isWorking = workShift && isWorkingDay(date, workShift);

      if (isHolidayDate || !isWorking) {
        // Weekly/Fortnightly:
        // skip this weekday and continue searching
        if (template.frequency === "Weekly") {
          continue;
        }

        // Monthly/Quarterly/HalfYearly/Yearly:
        // push to next working day
        date = await getNextWorkingDate(date, workShift);
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
  // let filteredRecurring = futureRecurring;
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
  // VISIBILITY
  // if (query.status !== "Upcoming") fmsQuery.isVisible = true;
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
    // .skip(skip)
    // .limit(limit)
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

  // // ✅ ONLY FMS TASKS
  // if (taskType === "FmsInstanceTask") {
  //   allTasks = isFmsEnabled ? [...mappedFmsTasks] : [];
  // }
  // //**This is for FMS task with normal task in task reassignment */
  // // else if (taskType == "All") {
  // //   allTasks.push(...tasks);
  // //   allTasks.push(...mappedFmsTasks);
  // // }
  // // ✅ ONLY NORMAL TASKS
  // else if (taskType) {
  //   allTasks = isDoThisEnabled ? [...tasks] : [];
  // }
  // // ✅ ALL TASKS
  // else {
  //   if (isDoThisEnabled) {
  //     allTasks.push(...tasks);
  //   }

  //   if (isFmsEnabled) {
  //     allTasks.push(...mappedFmsTasks);
  //   }
  // }
  // const actualTotal = total + fmsTotal;
  const totalTasks = allTasks.length;

  const paginatedTasks = allTasks.slice(skip, skip + Number(limit));

  let recurringResponse = [];
  // const shouldShowFutureRecurring = taskType != "DelegationTask";

  const shouldShowFutureRecurring =
    taskCategory === "upcoming" && (!taskType || taskType === "RecurringTask");

  if (shouldShowFutureRecurring) {
    recurringResponse = finalVirtualRecurring;
  }
  res.json({
    success: true,
    // data: tasks,
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

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

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
  // 📊 STATUS / STAT FILTER
  // =========================
  if (stat === "overdue") {
    fmsQuery.plannedDueDate = { $lt: todayStart };
    // Excluded "Not Done" so it doesn't show in overdue
    fmsQuery.status = { $nin: ["Completed", "Stopped", "Not Done"] };
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

      const isHolidayDate = await isHoliday(date);

      const isWorking = workShift && isWorkingDay(date, workShift);

      if (isHolidayDate || !isWorking) {
        // Weekly/Fortnightly:
        // skip this weekday and continue searching
        if (template.frequency === "Weekly") {
          continue;
        }

        // Monthly/Quarterly/HalfYearly/Yearly:
        // push to next working day
        date = await getNextWorkingDate(date, workShift);
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
  // let filteredRecurring = futureRecurring;
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
  // VISIBILITY
  // if (query.status !== "Upcoming") fmsQuery.isVisible = true;
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
    // .skip(skip)
    // .limit(limit)
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

  // // ✅ ONLY FMS TASKS
  // if (taskType === "FmsInstanceTask") {
  //   allTasks = isFmsEnabled ? [...mappedFmsTasks] : [];
  // }

  // // ✅ ONLY NORMAL TASKS
  // else if (taskType) {
  //   allTasks = isDoThisEnabled ? [...tasks] : [];
  // }

  // // ✅ ALL TASKS
  // else {
  //   if (isDoThisEnabled) {
  //     allTasks.push(...tasks);
  //   }

  //   if (isFmsEnabled) {
  //     allTasks.push(...mappedFmsTasks);
  //   }
  // }
  // const actualTotal = total + fmsTotal;
  const totalTasks = allTasks.length;

  let recurringResponse = [];
  // const shouldShowFutureRecurring = taskType != "DelegationTask";

  const shouldShowFutureRecurring =
    taskCategory === "upcoming" && taskType != "DelegationTask";

  if (shouldShowFutureRecurring) {
    recurringResponse = finalVirtualRecurring;
  }
  const finalData = [
    ...allTasks,
    ...(isDoThisEnabled ? recurringResponse : []),
  ];

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
  // VISIBILITY
  // if (query.status !== "Upcoming") fmsQuery.isVisible = true;
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
    // .skip(skip)
    // .limit(limit)
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

  // const actualTotal = total + fmsTotal;
  const totalTasks = allTasks.length;

  const finalData = [...allTasks];

  res.json({
    success: true,
    total: finalData.length,
    data: finalData,
  });
});
//**get my task stats */
export const getTaskStats = handleAsync(async (req, res) => {
  const { userId, creatorOrAssignorId, departmentId, createdBy } = req.body;

  const baseConditions = [];

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());
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
  const baseQuery = { isDeleted: { $ne: true } };

  if (baseConditions.length > 0) {
    baseQuery.$and = baseConditions;
  }

  // visibility same as main API
  baseQuery.isVisible = true;
  // let recurringFutureCount = 0;

  // if (isDoThisEnabled) {
  //   const recurringTemplates = await Task.find({
  //     ...baseQuery,
  //     taskType: "RecurringTask",
  //     status: { $ne: "Completed" },
  //     frequency: { $ne: "Daily" },
  //   }).lean();

  //   recurringFutureCount = recurringTemplates.filter((template) => {
  //     for (let i = 1; i <= 365; i++) {
  //       const futureDate = new Date();
  //       futureDate.setDate(futureDate.getDate() + i);

  //       if (
  //         template.endDate &&
  //         futureDate > endOfDay(new Date(template.endDate))
  //       ) {
  //         break;
  //       }

  //       // ✅ valid future occurrence found
  //       if (isTaskValidForToday(template, futureDate)) {
  //         return true;
  //       }
  //     }

  //     return false;
  //   }).length;
  // }
  // =========================================================
  // 🚀 PARALLEL COUNTS (MATCHING YOUR MAIN LOGIC)
  // =========================================================
  const [total, completed, pending, overdue] = await Promise.all([
    // TOTAL
    isDoThisEnabled
      ? Task.countDocuments({
          ...baseQuery,
          taskType: { $ne: "RecurringTask" },
        })
      : Promise.resolve(0),
    // COMPLETED
    isDoThisEnabled
      ? Task.countDocuments({
          ...baseQuery,
          taskType: { $ne: "RecurringTask" },
          status: "Completed",
        })
      : Promise.resolve(0),

    // PENDING
    isDoThisEnabled
      ? Task.countDocuments({
          ...baseQuery,
          taskType: { $ne: "RecurringTask" },
          status: "Pending",
        })
      : Promise.resolve(0),

    // OVERDUE
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
    isFmsEnabled
      ? FmsInstanceTask.countDocuments(fmsQuery)
      : Promise.resolve(0),

    // COMPLETED
    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          status: "Completed",
        })
      : Promise.resolve(0),

    // PENDING
    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          status: "Pending",
        })
      : Promise.resolve(0),

    // OVERDUE
    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          plannedDueDate: { $lt: todayStart },
          status: { $nin: ["Completed", "Stopped"] },
        })
      : Promise.resolve(0),
  ]);

  // res.json({
  //   success: true,
  //   stats: {
  //     total: total + fmsTotal,
  //     completed: completed + fmsCompleted,
  //     pending: pending + fmsPending,
  //     overdue: overdue + fmsOverdue,
  //   },
  // });
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

  const baseConditions = [];

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

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

  //**FMS Stats */
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

  // visibility same as tasks
  // fmsQuery.isVisible = true;
  const [fmsTotal, fmsCompleted, fmsPending, fmsOverdue] = await Promise.all([
    // TOTAL
    isFmsEnabled
      ? FmsInstanceTask.countDocuments(fmsQuery)
      : Promise.resolve(0),

    // COMPLETED
    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          status: "Completed",
        })
      : Promise.resolve(0),

    // PENDING
    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          status: "Pending",
        })
      : Promise.resolve(0),

    // OVERDUE (Excluded "Not Done" along with "Completed" and "Stopped")
    isFmsEnabled
      ? FmsInstanceTask.countDocuments({
          ...fmsQuery,
          plannedDueDate: { $lt: todayStart },
          status: { $nin: ["Completed", "Stopped", "Not Done"] },
        })
      : Promise.resolve(0),
  ]);

  // =========================================================
  // 📤 RESPONSE
  // =========================================================
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
//**for role based task listing */
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
    taskTypeFilter = "all", // "all" | "dothis" | "fms"
  } = req.body;

  const role = rawRole ? rawRole.toLowerCase().replace(/\s+/g, "") : "";
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const { stat, taskCategory, status, taskType } = filters;

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

  // =========================
  // 1. MODULE ENABLE CHECK
  // =========================
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

  // =========================
  // 2. BUILD DO_THIS (TASK) QUERY
  // =========================
  const query = { isDeleted: { $ne: true } };
  const andConditions = [];

  if (shouldFetchDoThis) {
    // Role Access
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

    // Search
    if (search) {
      andConditions.push({
        $or: [{ title: { $regex: search, $options: "i" } }, { TaskId: search }],
      });
    }

    // Stat Filter
    if (stat === "overdue") {
      andConditions.push({
        $or: [
          { taskType: "DelegationTask", dueDate: { $lt: todayEnd } },
          { taskType: "RecurringTask", endDate: { $lt: todayEnd } },
        ],
        status: { $ne: "Completed" },
      });
    }

    if (stat === "dueToday") {
      andConditions.push({ dueDate: { $gte: todayStart, $lte: todayEnd } });
    }

    if (stat === "completed") {
      andConditions.push({ status: "Completed" });
    }

    // Tab Filter
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

    // Status Filter
    if (status && status !== "all") {
      if (status === "Reopened") {
        andConditions.push({ isReopen: true });
      } else {
        andConditions.push({ status });
      }
    }

    // ⚡ FIX: Push taskType check inside andConditions to prevent root query mutation collisions
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

  // =========================
  // 3. BUILD FMS QUERY
  // =========================
  const fmsQuery = {
    isTerminated: { $ne: true },
    status: { $nin: ["Terminated"] },
  };
  const fmsAndConditions = [];

  if (shouldFetchFms) {
    // Role Access
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

    // Search
    if (search) {
      fmsAndConditions.push({
        $or: [
          { description: { $regex: search, $options: "i" } },
          { taskId: search },
        ],
      });
    }

    // Status
    if (status && status !== "all") {
      fmsAndConditions.push({ status });
    }

    // Stat Filter
    if (stat === "overdue") {
      fmsAndConditions.push({
        plannedDueDate: { $lt: todayStart },
        status: { $nin: ["Completed", "Stopped", "Not Done"] },
      });
    }

    if (stat === "dueToday") {
      fmsAndConditions.push({
        plannedDueDate: { $gte: todayStart, $lte: todayEnd },
      });
    }

    // Tab Filter
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

  // =========================
  // 4. EXECUTE & MAP RESULTS
  // =========================
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
    creatorOrAssignorId, // New parameter for tasks created by OR assigned by
    page = 1, // Default to page 1
    limit = 10, // Default to 10 items per page
    taskCategory, // New parameter for filtering by 'today', 'upcoming', 'completed'
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

  // ✅ only non-admin/non-owner
  if (!isSuperUser) {
    filterQuery.createdBy = loggedInUserId;
  }
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
        // reopenedBy,
        existingTask.assignedTo?._id,
        existingTask.assignedBy?._id,
      ].filter(Boolean),
    });

    existingTask.conversationId = conversation._id;
    await existingTask.save();
  }
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
    const io = getIO();

    // Send realtime notification to assigned user
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
    // ======================================================
    // EMAIL NOTIFICATION
    // ======================================================

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
      // sendEmail({
      //   to: existingTask.assignedBy.email,
      //   subject: `🔁 Task Reopened — ${existingTask.TaskId}: ${existingTask.title}`,
      //   html: `
      //   <p>Task completed successfully.</p>

      //   <p><strong>Task:</strong> ${existingTask.title}</p>

      //   <a href="${frontendUrl}">
      //     View Task
      //   </a>
      // `,
      // });
    }
    sendNotification({
      type: "TASK_COMPLETED",
      task: existingTask,
      actor: req.user,
      userId: existingTask.assignedBy._id,
    });
    // ======================================================
    // DATABASE NOTIFICATION
    // ======================================================

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
        const workShift = depTask.assignedTo.assignShift;
        if (!workShift) continue;

        const parentStart = updatedTask.startDate; // parent planned start
        const parentDue = updatedTask.dueDate; // parent planned due
        let childStart;
        let childDue;
        if (!parentStart || !parentDue) {
          continue;
        }
        const isSameShift =
          String(workShift?._id) === String(parentWorkShift?._id);
        if (!isSameShift) {
          console.log("⚠️ Shift mismatch → using child shift calendar");

          const x = Number(depTask.dependencyConfig.xValue || 0);
          const freqStr = (
            depTask.dependencyConfig.isDependentFrequency || ""
          ).toLowerCase();

          const baseDate = new Date(parentStart);

          const start = await nextWorkingShiftDate(baseDate, workShift._id);

          childStart = snapToShiftTime(start, workShift, true);

          childDue = new Date(childStart);

          // ======================================================
          // HOURS
          // ======================================================
          if (freqStr.includes("hour")) {
            let calculatedDue = new Date(childStart);

            calculatedDue.setHours(calculatedDue.getHours() + x);

            const shiftEnd = snapToShiftTime(childStart, workShift, false);

            if (calculatedDue < shiftEnd) {
              childDue = calculatedDue;
            } else {
              const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();

              let nextDay = new Date(childStart);
              nextDay.setDate(nextDay.getDate() + 1);

              let nextWorkingDay = await nextWorkingShiftDate(
                nextDay,
                workShift._id,
              );

              const nextShiftStart = snapToShiftTime(
                nextWorkingDay,
                workShift,
                true,
              );

              childDue = new Date(nextShiftStart.getTime() + overflowMs);
            }
          }

          // ======================================================
          // DAYS
          // ======================================================
          else {
            childDue = await addWorkingDaysHoliday(
              childStart,
              x,
              workShift._id,
            );

            const shiftEndTime = snapToShiftTime(childDue, workShift, false);

            childDue.setHours(
              shiftEndTime.getHours(),
              shiftEndTime.getMinutes(),
              shiftEndTime.getSeconds(),
              shiftEndTime.getMilliseconds(),
            );
          }
        } else {
          // ======================================================
          // CHILD START = PARENT START
          // ======================================================
          childStart = new Date(updatedTask.completedAt);

          childDue = new Date(parentDue);

          const x = Number(depTask.dependencyConfig.xValue || 0);
          const freqStr = (
            depTask.dependencyConfig.isDependentFrequency || ""
          ).toLowerCase();

          // ======================================================
          // HOURS
          // ======================================================
          if (freqStr.includes("hour")) {
            let calculatedDue = new Date(parentDue);

            // add x hours to parent due
            calculatedDue.setHours(calculatedDue.getHours() + x);

            const shiftEnd = snapToShiftTime(parentDue, workShift, false);

            // within shift
            if (calculatedDue < shiftEnd) {
              childDue = calculatedDue;
            } else {
              // overflow after shift end
              const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();

              let nextDay = new Date(parentDue);
              nextDay.setDate(nextDay.getDate() + 1);

              let nextWorkingDay = await nextWorkingShiftDate(
                nextDay,
                workShift._id,
              );

              const nextShiftStart = snapToShiftTime(
                nextWorkingDay,
                workShift,
                true,
              );

              // next shift start + overflow
              childDue = new Date(nextShiftStart.getTime() + overflowMs);
            }
          }

          // ======================================================
          // DAYS
          // ======================================================
          else {
            childDue = await addWorkingDaysHoliday(parentDue, x, workShift._id);

            childDue.setHours(
              parentDue.getHours(),
              parentDue.getMinutes(),
              parentDue.getSeconds(),
              parentDue.getMilliseconds(),
            );

            const shiftEnd = snapToShiftTime(childDue, workShift, false);

            if (childDue >= shiftEnd) {
              let nextDay = new Date(childDue);
              nextDay.setDate(nextDay.getDate() + 1);

              let nextWorkingDay = await nextWorkingShiftDate(
                nextDay,
                workShift._id,
              );

              childDue = snapToShiftTime(nextWorkingDay, workShift, false);
            }
          }
        }
        // ======================================================
        // UPDATE CHILD
        // ======================================================
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

    // 🔥 Soft Delete: Keep document in DB so instanceKey persists & prevents Cron re-creation
    task.isDeleted = true;
    await task.save();

    // Save history
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

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError("Invalid ID", 400));
  }

  // 1. Find parent first
  const parent = await Task.findById(id);
  if (!parent) {
    return next(new AppError("Task not found", 404));
  }

  // 2. Collect parent + all dependent tasks
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

  // 3. Delete tasks first (important for consistency)
  await Task.deleteMany({ _id: { $in: toDeleteIds } });

  // 4. Update related data AFTER delete (avoids partial dependency issues)
  if (parent.bucketId) {
    await TaskBucket.updateOne(
      { _id: parent.bucketId },
      { $pull: { generatedTasks: { $in: toDeleteIds } } },
    );
  }

  // 5. Save history LAST (so delete is already successful)
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

  // ── Result tracking ────────────────────────────────────────────────────
  const importLog = []; // one entry per row — success or error
  const validTasks = []; // task instances ready to insertMany
  let rows = [];
  let rowCount = 0;

  try {
    // ── 1. Parse file ────────────────────────────────────────────────────
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

    // ── 2. Header validation ─────────────────────────────────────────────
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

    // ── 3. Process each row independently ────────────────────────────────
    for (const row of rows) {
      rowCount++;

      // Each row gets its own try/catch — errors here SKIP the row, not abort
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

        // Required field check
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

        // ── Build usersForThisRow ────────────────────────────────────────
        const usersForThisRow = [];

        // CASE 1: one user → multiple departments
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
        }
        // CASE 2: multiple users → matching departments
        else {
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

        // ── Dates ────────────────────────────────────────────────────────
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

        // ── Normalise dependent frequency ────────────────────────────────
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

        // ── Attachment ───────────────────────────────────────────────────
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

        // ── Per-user task creation ────────────────────────────────────────
        const rowCreated = []; // track tasks created in THIS row for the log

        for (const item of usersForThisRow) {
          const { user, departmentId, departmentName: deptLabel } = item;

          // Duplicate check
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
              // Log this specific user as skipped but don't throw — continue other users in same row
              importLog.push({
                row: rowCount,
                status: "skipped",
                reason: `Duplicate: task "${title.trim()}" for ${user.email} on same start date already exists.`,
                user: user.email,
                department: deptLabel,
                taskTitle: title.trim(),
              });
              continue; // skip this user, not the whole row
            }
          }

          // ── Build task data ──────────────────────────────────────────
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

          // ── Auto-generate TaskId ────────────────────────────────────
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
        } // end per-user loop

        // Log success for this row (one entry per user+dept pair created)
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
        // Row-level failure — log it and continue to next row
        importLog.push({
          row: rowCount,
          status: "error",
          reason: rowError.message,
          user: row["Assign To(Email)"] || "",
          department: row["Assign To UserDepartment"] || "",
          taskTitle: row["Task Title"] || "",
          taskId: null,
        });
        // ↑ No `continue` needed — for-loop naturally moves to next row
      }
    } // end rows loop

    // ── 4. Insert all valid tasks ─────────────────────────────────────────
    let insertedCount = 0;
    if (validTasks.length > 0) {
      await Task.insertMany(validTasks);
      insertedCount = validTasks.length;
    }

    // ── 5. Build summary ──────────────────────────────────────────────────
    const importedRows = importLog.filter((l) => l.status === "imported");
    const skippedRows = importLog.filter((l) => l.status === "skipped");
    const errorRows = importLog.filter((l) => l.status === "error");

    // Generate error/skip CSV only when there are failures
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

    // ── 6. Response ───────────────────────────────────────────────────────
    // Always 200 here — partial imports are valid results, not HTTP errors
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
      log: importLog, // full per-row log — frontend can display a table
      errorFile, // CSV download link for failed rows (null if all succeeded)
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
const applyTaskEndTime = (date, taskEndTime) => {
  if (!date || !taskEndTime) return date;

  const [hours, minutes] = taskEndTime.split(":").map(Number);

  date.setHours(hours, minutes, 0, 0);

  return date;
};
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
    taskEndDays,
    taskEndTime, // <--- We capture this explicitly to check later
    ...otherUpdates
  } = req.body;

  // 3. Apply general updates
  Object.assign(task, otherUpdates);

  // Apply Status if present (Manually applied to ensure we track the change)
  if (status) {
    task.status = status;
  }

  // 4. Handle specific fields (File, User, Checklists)
  const oldAssignedTo = task.assignedTo?.toString();

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
  if (startDate !== undefined && cleanField(startDate)) {
    const oldStartDate = task.startDate; // existing DB value

    const newDate = new Date(startDate);

    if (oldStartDate) {
      newDate.setHours(
        oldStartDate.getHours(),
        oldStartDate.getMinutes(),
        oldStartDate.getSeconds(),
        oldStartDate.getMilliseconds(),
      );
    }

    task.startDate = newDate;
  }
  if (dueDate !== undefined && cleanField(dueDate)) {
    const oldDueDate = task.dueDate;

    const newDate = new Date(dueDate);

    if (oldDueDate) {
      newDate.setHours(
        oldDueDate.getHours(),
        oldDueDate.getMinutes(),
        oldDueDate.getSeconds(),
        oldDueDate.getMilliseconds(),
      );
    }

    task.dueDate = newDate;
  }
  let effectiveStartDate = task.startDate;

  // Save taskEndTime if frontend sends it
  if (taskEndTime !== undefined) {
    task.taskEndTime = taskEndTime;
  }

  // Save taskEndDays if frontend sends it
  if (taskEndDays !== undefined) {
    task.taskEndDays = taskEndDays;
  }

  // ✅ Highest priority: explicit endDate from frontend
  if (endDate !== undefined && cleanField(endDate)) {
    task.dueDate = new Date(endDate);
  }
  // Otherwise calculate from taskEndDays
  else if (task.taskEndDays && task.assignedTo) {
    const user = await User.findById(task.assignedTo).populate("assignShift");

    if (user?.assignShift) {
      const workShiftId = user.assignShift._id;

      task.dueDate = await addWorkingDaysHoliday(
        effectiveStartDate,
        Number(task.taskEndDays),
        workShiftId,
      );

      // Apply custom time only if available
      if (task.taskEndTime) {
        task.dueDate = applyTaskEndTime(task.dueDate, task.taskEndTime);
      }
    }
  }
  // Only update the time of existing dueDate
  else if (task.taskEndTime && task.dueDate) {
    task.dueDate = applyTaskEndTime(task.dueDate, task.taskEndTime);
  }
  // 5. Handle discriminator-specific fields (RecurringTask)
  let recurrenceEnd = null;
  if (task.taskType === "RecurringTask") {
    const assignedUser = await User.findById(task.assignedTo).populate(
      "assignShift",
    );
    if (!assignedUser) {
      return next(
        new AppError(`User with ID ${task.assignedTo} not found`, 404),
      );
    }

    const workShift = assignedUser.assignShift;
    if (!workShift) {
      return next(
        new AppError(`No workshift assigned to user ${assignedUser.name}`, 400),
      );
    }
    if (frequency !== undefined) task.frequency = cleanField(frequency);
    if (endDate !== undefined && cleanField(endDate)) {
      const selectedEndDate = new Date(endDate);

      recurrenceEnd = await nextWorkingShiftDate(
        selectedEndDate,
        workShift._id,
      );

      // Preserve the selected time from the frontend
      recurrenceEnd.setHours(
        selectedEndDate.getHours(),
        selectedEndDate.getMinutes(),
        selectedEndDate.getSeconds(),
        selectedEndDate.getMilliseconds(),
      );

      task.endDate = recurrenceEnd;
    }
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

        // ======================
        // HOURS
        // ======================
        if (freqStr.includes("hour")) {
          let calculatedDate = new Date(baseDate);

          calculatedDate.setHours(calculatedDate.getHours() + x);

          const shiftStart = snapToShiftTime(calculatedDate, workShift, true);

          const shiftEnd = snapToShiftTime(calculatedDate, workShift, false);

          if (calculatedDate < shiftStart) {
            newStartDate = shiftStart;
          } else if (calculatedDate >= shiftEnd) {
            const nextDay = new Date(calculatedDate);
            nextDay.setDate(nextDay.getDate() + 1);

            newStartDate = await nextWorkingShiftDate(nextDay, workShift._id);
          } else {
            newStartDate = calculatedDate;
          }
        }

        // ======================
        // DAYS
        // ======================
        else {
          let plannedDate = await addWorkingDaysHoliday(
            baseDate,
            x,
            workShift._id,
          );

          // preserve actual completion time
          plannedDate.setHours(
            baseDate.getHours(),
            baseDate.getMinutes(),
            baseDate.getSeconds(),
            baseDate.getMilliseconds(),
          );

          const shiftStart = snapToShiftTime(plannedDate, workShift, true);

          const shiftEnd = snapToShiftTime(plannedDate, workShift, false);

          if (plannedDate < shiftStart) {
            plannedDate = shiftStart;
          } else if (plannedDate >= shiftEnd) {
            const nextDay = new Date(plannedDate);
            nextDay.setDate(nextDay.getDate() + 1);

            plannedDate = await nextWorkingShiftDate(nextDay, workShift._id);
          }

          newStartDate = plannedDate;
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
          newDueDate = await addWorkingDaysHoliday(
            newStartDate,
            taskDays,
            workShift._id,
          );

          newDueDate = snapToShiftTime(newDueDate, workShift, false);
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
// =========================================================
// ✅ UPDATE RECURRING GENERATED TASK ASSIGNEE
// =========================================================

export const updateRecurringGeneratedTaskAssignee = async ({
  recurringTaskId,
  assignedTo,
  updatedBy,
}) => {
  try {
    if (!recurringTaskId || !assignedTo) return;

    // ✅ new assigned user
    const assignedUser =
      await User.findById(assignedTo).populate("assignShift");

    // ✅ find generated delegated tasks
    // skip completed tasks
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
      // ✅ update assignee
      task.assignedTo = assignedTo;

      // // ✅ update department if exists
      // if (assignedUser?.department?.length > 0) {
      //   task.departmentOfAssignToUser =
      //     assignedUser.department[0];
      // }

      // // ✅ recalculate due date using new shift
      // if (
      //   task.startDate &&
      //   task.taskEndDays &&
      //   assignedUser?.assignShift
      // ) {
      //   task.dueDate = await addWorkingDaysHoliday(
      //     task.startDate,
      //     Number(task.taskEndDays),
      //     assignedUser.assignShift._id,
      //   );
      // }

      task.updatedBy = updatedBy;
      task.updatedAt = new Date();

      await task.save();
    }

    console.log(`✅ Successfully updated generated recurring tasks`);
  } catch (error) {
    console.error("❌ updateRecurringGeneratedTaskAssignee Error:", error);
  }
};
