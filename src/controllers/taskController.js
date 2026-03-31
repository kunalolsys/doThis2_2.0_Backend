import { Task, DelegationTask, RecurringTask } from "../models/Task.js";
import { isSameDay, isAfter, startOfDay, endOfDay } from "date-fns";
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
import moment from "moment";
import {
  calculateActivationDate,
  nextWorkingShiftDate,
  isWorkingDay,
  addWorkingDays,
} from "../utils/dateCalculator.js";
import { createLog } from "./logController.js";

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

    case "Quarterly":
      return start.getDate() === date && [1, 4, 7, 10].includes(month);

    case "Half Yearly":
      return start.getDate() === date && [1, 7].includes(month);

    case "Yearly":
      return start.getDate() === date && start.getMonth() + 1 === month;

    default:
      return false;
  }
};
// const normalizeDate = (dateVal) => {
//   if (!dateVal) return null;

//   const d = new Date(dateVal);
//   d.setHours(0, 0, 0, 0);
//   return d;
// };

// const calculateStatus = (task) => {
//   const today = new Date();
//   today.setHours(0, 0, 0, 0);

//   const start = normalizeDate(task.startDate);
//   const due = normalizeDate(task.dueDate);

//   // ✅ 1. Completed (highest priority)
//   if (task.completeStatus === true) {
//     return "Completed";
//   }

//   // 🔵 2. Upcoming (ONLY future start date)
//   if (start && start.getTime() > today.getTime()) {
//     return "Upcoming";
//   }

//   // ⚠️ 3. Delayed (due TODAY)
//   if (due && due.getTime() === today.getTime()) {
//     return "Delayed";
//   }

//   // 🔴 4. Overdue (past due date)
//   if (due && due.getTime() < today.getTime()) {
//     return "Overdue";
//   }

//   // 🟢 5. Pending (everything else)
//   return "Pending";
// };
// ---------------------------------------------------------
// CREATE TASK (Handles Bulk Assignment, Recurring & Delegation)
// ---------------------------------------------------------
// export const createTask = handleAsync(async (req, res, next) => {
//   const {
//     assignedTo, // Can be a single ID string, or a JSON string array of IDs
//     title,
//     description,
//     departmentOfAssignToUser, // NEW: Accept department from frontend
//     startDate,
//     dueDate,
//     taskEndDays, // New field for task end days
//     checklist,
//     frequency,
//     weekDays,
//     isDependent,
//     parentTask,
//     startTimeSetting,
//     isDependentFrequency,
//     xValue,
//     isRecurrent,
//     recurrenceFrequency,
//     recurrenceEndDate,
//   } = req.body;
//   // 1. Basic Validation
//   if (!assignedTo || !title || !description?.trim()) {
//     return next(
//       new AppError("Required fields: assignedTo, title, description", 400),
//     );
//   }

//   // --- PARSE ASSIGNEES (Handle Multiple Users) ---
//   let assigneeIds = [];
//   try {
//     // Check if it's a JSON string array (e.g. "['id1', 'id2']")
//     if (
//       typeof assignedTo === "string" &&
//       (assignedTo.startsWith("[") || assignedTo.includes(","))
//     ) {
//       const parsed = JSON.parse(assignedTo);
//       assigneeIds = Array.isArray(parsed) ? parsed : [assignedTo];
//     } else {
//       // Single ID
//       assigneeIds = [assignedTo];
//     }
//   } catch (e) {
//     // Fallback if JSON parse fails but it's just a simple string ID
//     assigneeIds = [assignedTo];
//   }

//   // Validate all IDs
//   const validAssigneeIds = assigneeIds.filter((id) =>
//     mongoose.Types.ObjectId.isValid(id),
//   );
//   if (validAssigneeIds.length === 0) {
//     return next(new AppError("Invalid User ID(s) provided", 400));
//   }

//   // 2. Parse FormData Booleans and Clean Data
//   const isRec = isRecurrent === "true" || isRecurrent === true;
//   const isDep = isDependent === "true" || isDependent === true;
//   const isActualToPlanned = isDep && startTimeSetting === "actual-to-planned";

//   // Parse Checklist
//   let parsedChecklist = [];
//   if (checklist) {
//     try {
//       if (typeof checklist === "string") {
//         parsedChecklist = JSON.parse(checklist);
//       } else if (Array.isArray(checklist)) {
//         parsedChecklist = checklist;
//       }
//     } catch (error) {
//       console.error("Error parsing checklist:", error);
//       parsedChecklist = [];
//     }
//   }

//   // Parse and sanitize taskEndDays so invalid values don't become NaN
//   let parsedTaskEndDays = null;
//   if (
//     taskEndDays !== undefined &&
//     taskEndDays !== null &&
//     String(taskEndDays).trim() !== ""
//   ) {
//     const tmp = Number(taskEndDays);
//     parsedTaskEndDays = Number.isFinite(tmp) ? tmp : null;
//   }

//   const dependencyData = {
//     taskDependent: cleanField(parentTask),
//     startTimeSetting: cleanField(startTimeSetting),
//     isDependentFrequency: cleanField(isDependentFrequency),
//     xValue:
//       xValue && xValue !== "null" && xValue !== "" ? Number(xValue) : null,
//   };

//   const userId = req.user?._id || null;
//   // If task is actual-to-planned, startDate must be null unless explicitly provided.
//   // Otherwise, default to now.
//   const parsedStartDate = cleanField(startDate)
//     ? parseDateIST(startDate)
//     : isActualToPlanned
//       ? null
//       : new Date();
//   let calculatedDueDate = null;

//   // Calculate due date if taskEndDays is provided and valid
//   if (parsedTaskEndDays !== null && parsedStartDate) {
//     const start = new Date(parsedStartDate);
//     start.setDate(start.getDate() + parsedTaskEndDays);
//     calculatedDueDate = start;
//   }

//   // 3. LOOP AND CREATE TASKS
//   const createdTasks = [];

//   // We loop through every selected user and create a separate task for them
//   for (const assigneeId of validAssigneeIds) {
//     // 3a. Get user to determine department
//     const assignedUser = await User.findById(assigneeId);
//     if (!assignedUser) {
//       return next(new AppError(`User with ID ${assigneeId} not found`, 404));
//     }

//     // 3b. Determine department: use provided one, or first from user's departments
//     let deptId = null;
//     if (departmentOfAssignToUser) {
//       // Frontend provided a specific department
//       deptId = departmentOfAssignToUser;
//     } else if (assignedUser.department) {
//       // Use user's first/primary department
//       if (
//         Array.isArray(assignedUser.department) &&
//         assignedUser.department.length > 0
//       ) {
//         deptId = assignedUser.department[0]._id || assignedUser.department[0];
//       } else if (typeof assignedUser.department === "object") {
//         deptId = assignedUser.department._id || assignedUser.department;
//       } else {
//         deptId = assignedUser.department;
//       }
//     }

//     const commonFields = {
//       title: title.trim(),
//       description: description.trim(),
//       assignedTo: assigneeId, // Unique per loop iteration
//       assignedBy: userId,
//       createdBy: userId,
//       updatedBy: userId,
//       isDependent: isDep,
//       dependencyConfig: dependencyData,
//       taskEndDays: parsedTaskEndDays,
//       // status: 'Pending',
//       startDate: parsedStartDate,
//       dueDate: calculatedDueDate || cleanField(dueDate), // Use calculated due date if available
//       departmentOfAssignToUser: deptId, // Set the department
//       checklist: parsedChecklist,
//     };
//     // commonFields.status = calculateStatus({
//     //   ...commonFields,
//     //   completeStatus: false, // New field for status calculation
//     // }); // Calculate initial status based on dates
//     // If this is a dependent task and a parentTask is provided, compute child's startDate and dueDate
//     if (isDep && dependencyData.taskDependent) {
//       // This block calculates the start/due dates for PLANNED-TO-PLANNED dependent tasks at creation time.
//       // For ACTUAL-TO-PLANNED, these fields remain null until the parent is completed.
//       if (dependencyData.startTimeSetting === "planned-to-planned") {
//         try {
//           // Parent may be provided as TaskId string or ObjectId
//           let parent = null;
//           if (mongoose.Types.ObjectId.isValid(dependencyData.taskDependent)) {
//             parent = await Task.findById(dependencyData.taskDependent).lean();
//           }
//           if (!parent) {
//             // Try finding by TaskId field (e.g., '25120001')
//             parent = await Task.findOne({
//               TaskId: String(dependencyData.taskDependent),
//             }).lean();
//           }

//       if (parent) {
//             // Determine parent end date: prefer dueDate, then endDate (recurring), then startDate
//             const parentEnd =
//               parent.dueDate || parent.endDate || parent.startDate || null;
//             if (parentEnd) {
//               const baseDate = new Date(parentEnd);

//               // Determine offset X and whether in days or hours
//               const x =
//                 dependencyData.xValue !== null &&
//                 dependencyData.xValue !== undefined
//                   ? Number(dependencyData.xValue)
//                   : 0;
//               const freqStr = (
//               dependencyData.isDependentFrequency || ""
//             ).toLowerCase();

//               let childStart = new Date(baseDate);
//               if (freqStr.includes("hour")) {
//                 childStart.setHours(childStart.getHours() + x);
//               } else {
//                 // default to days
//                 childStart.setDate(childStart.getDate() + x);
//               }

//               // Compute due date if a sanitized parsedTaskEndDays is available
//               let childDue = null;
//               if (parsedTaskEndDays !== null) {
//                 childDue = new Date(childStart);
//                 const addDays = Math.max(0, Number(parsedTaskEndDays) - 1); // off-by-one rule
//                 childDue.setDate(childDue.getDate() + addDays);
//               }

//               // Override commonFields startDate / dueDate for this child
//             commonFields.startDate = childStart;
//               if (childDue) commonFields.dueDate = childDue;
//             }
//           }
//         } catch (err) {
//           console.error("Error computing dependent child dates:", err);
//         }
//       }
//     }

//     let newTask;

//     // --- LOGIC BRANCHING (Same as before, just inside loop) ---
//     if (isRec) {
//       // Recurring Logic
//       let modelFrequency = frequency || recurrenceFrequency;
//       const freqMap = {
//         daily: "Daily",
//         weekly: "Weekly",
//         fortnightly: "Fortnightly",
//         monthly: "Monthly",
//         quarterly: "Quarterly",
//         "half-yearly": "Half Yearly",
//         yearly: "Yearly",
//       };
//       if (modelFrequency && freqMap[modelFrequency.toLowerCase()]) {
//         modelFrequency = freqMap[modelFrequency.toLowerCase()];
//       }

//       if (!modelFrequency)
//         return next(new AppError("Frequency is required", 400));

//       // Holiday Check (Start Date) - Check once ideally, but checking per loop is safe
//       const startHoliday = await Holiday.findOne({
//         date: startOfDay(parsedStartDate),
//       });
//       if (startHoliday)
//         return next(
//           new AppError(`Start date is a holiday: ${startHoliday.name}`, 400),
//         );

//       let parsedWeekDays = [];
//       if (weekDays) {
//         let days = [];
//         try {
//           if (typeof weekDays === "string") {
//             days = JSON.parse(weekDays);
//           } else if (Array.isArray(weekDays)) {
//             days = weekDays;
//           }
//         } catch (error) {
//           if (typeof weekDays === "string") {
//             days = weekDays
//               .split(",")
//               .map((d) => d.trim())
//               .filter(Boolean);
//           }
//         }
//         if (Array.isArray(days)) {
//           parsedWeekDays = days.map((day) => day.toLowerCase());
//         }
//       }

//       // Debug: log whether file was received for recurring task creation
//       console.log(
//         "createTask: recurring req.file ->",
//         req.file ? req.file.filename : null,
//       );

//       newTask = new RecurringTask({
//         ...commonFields,
//         frequency: modelFrequency,
//         weekDays: parsedWeekDays,
//         startDate: parsedStartDate,
//         // status: calculateStatus(commonFields),
//         endDate: cleanField(recurrenceEndDate)
//           ? parseDateIST(recurrenceEndDate)
//           : null,
//         // attachmentFile: req.file ? req.file.filename : null, // Save attachment for recurring tasks
//         attachmentFile: req.files
//           ? req.files.map((file) => `${req.uploadFolder}/${file.filename}`)
//           : [],
//       });
//     } else {
//       // Delegation Logic
//       // Prefer a dueDate computed earlier for dependent children (commonFields.dueDate).
//       // Fall back to an explicitly provided dueDate from the request if no computed value exists.
//       const due = commonFields.dueDate
//         ? commonFields.dueDate
//         : cleanField(dueDate)
//           ? parseDateIST(dueDate)
//           : null;

//       if (due) {
//         const dueHoliday = await Holiday.findOne({ date: startOfDay(due) });
//         if (dueHoliday)
//           return next(
//             new AppError(`Due date is a holiday: ${dueHoliday.name}`, 400),
//           );
//       }

//       if (cleanField(startDate)) {
//         const startHoliday = await Holiday.findOne({
//           date: startOfDay(parsedStartDate),
//         });
//         if (startHoliday)
//           return next(
//             new AppError(`Start date is a holiday: ${startHoliday.name}`, 400),
//           );
//       }

//       newTask = new DelegationTask({
//         ...commonFields,
//         dueDate: due,
//         // status: 'Pending',
//         status: calculateStatus({
//           ...commonFields,
//           dueDate: due,
//           completeStatus: false,
//         }),
//         // attachmentFile: req.file ? req.file.filename : null,
//         attachmentFile: req.files
//           ? req.files.map((file) => `${req.uploadFolder}/${file.filename}`)
//           : [],
//         taskDoneBy: null,
//         completeStatus: false,
//       });
//     }

//     // Save individual task
//     await newTask.save();
//     await createLog({
//       action: "CREATE",
//       module: "TASK",
//       documentId: newTask._id,
//       performedBy: req.cookies.userId,
//       newData: newTask,
//       message: `Task Created | Title: ${newTask.title} | ID: ${newTask.TaskId}`,
//     });
//     createdTasks.push(newTask);
//   }

//   // 4. Response
//   const defaultMessage = `${createdTasks.length} Task(s) created successfully`;
//   const responseJson = {
//     success: true,
//     message: defaultMessage,
//     data:
//       createdTasks.length === 1
//         ? normalizeTask(createdTasks[0])
//         : createdTasks.map(normalizeTask),
//   };

//   if (req.file && req.fileWasRenamed) {
//     responseJson.message = `file already exist so your file name is-${req.file.filename}. ${defaultMessage}`;
//     responseJson.renamedFile = req.file.filename;
//   }

//   res.status(201).json(responseJson);
// });

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

  const userId = req.user?._id || null;
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
      effectiveDueDate = await addWorkingDays(
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
      startDate: effectiveStartDate,
      dueDate: effectiveDueDate,
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
          console.log("🔗 Parent found:", parent._id);

          const parentEnd =
            parent.dueDate || parent.endDate || parent.startDate || null;

          console.log("📅 Parent End Date:", parentEnd);

          if (parentEnd) {
            const x = Number(dependencyData.xValue) || 0;
            const freqStr = (
              dependencyData.isDependentFrequency || ""
            ).toLowerCase();

            console.log("⚙️ Dependency Config:", {
              xValue: x,
              frequency: freqStr,
              parsedTaskEndDays,
            });

            let childBaseDate = new Date(parentEnd);
            console.log("📍 Initial Child Base Date:", childBaseDate);

            if (freqStr.includes("hour")) {
              console.log("⏱️ Processing in HOURS mode");

              childBaseDate.setHours(childBaseDate.getHours() + x);
              console.log("➕ After Hour Offset:", childBaseDate);

              commonFields.startDate = await nextWorkingShiftDate(
                childBaseDate,
                workShift._id,
              );

              console.log(
                "🟢 Final Start Date (after shift adjust):",
                commonFields.startDate,
              );
            } else {
              console.log("📆 Processing in DAYS mode");

              commonFields.startDate = await addWorkingDays(
                parentEnd,
                x,
                workShift._id,
              );

              console.log(
                "🟢 Final Start Date (working days):",
                commonFields.startDate,
              );
            }

            if (parsedTaskEndDays) {
              console.log(
                "📅 Calculating Due Date with offset:",
                parsedTaskEndDays,
              );

              commonFields.dueDate = await addWorkingDays(
                commonFields.startDate,
                parsedTaskEndDays,
                workShift._id,
              );

              console.log("🔴 Final Due Date:", commonFields.dueDate);
            } else {
              console.log("⚠️ No parsedTaskEndDays provided, skipping dueDate");
            }
          } else {
            console.log("❌ No parentEnd date found");
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
      console.log(parsedWeekDays);
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
        completeStatus: false,
      });
    }

    // 🔥 Set visibility: false initially (cron will enable at shift start)
    newTask.isVisible = false;

    // Save
    await newTask.save();
    await createLog({
      action: "CREATE",
      module: "TASK",
      documentId: newTask._id,
      performedBy: req.cookies.userId,
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

    // 👉 STATUS COUNTS
    // 👉 STATUS COUNTS (PURE JS - SAFE)
    const statusCounts = {
      Pending: tasks.filter((t) => t.status === "Pending").length,
      Completed: tasks.filter((t) => t.status === "Completed").length,
      Delayed: tasks.filter((t) => t.status === "Delayed").length,
      Upcoming: tasks.filter((t) => t.status === "Upcoming").length,
      Overdue: tasks.filter((t) => t.status === "Overdue").length,
    };

    // console.log("TOTAL TASKS:", tasks.length);
    // console.log("Counts:", statusCounts);

    return res.status(200).json({
      success: true,
      total: tasks.length,
      counts: statusCounts,
      data: tasks,
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
//**for my task listing */
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
  } = req.body;

  const skip = (page - 1) * limit;

  const { stat, taskCategory, status, taskType } = filters;

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
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),

    Task.countDocuments(query), // 🔥 Count only visible
  ]);

  res.json({
    success: true,
    data: tasks,
    totalTasks: total,
    currentPage: page,
    totalPages: Math.ceil(total / limit),
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

  // =========================================================
  // 📤 RESPONSE
  // =========================================================
  res.json({
    success: true,
    stats: {
      total,
      overdue,
      pending,
      completed,
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
  // 🚀 EXECUTE
  // =========================
  const [tasks, total] = await Promise.all([
    Task.find(query)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .populate("departmentOfAssignToUser", "name")
      .populate("dependencyConfig.taskDependent", "title")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),

    Task.countDocuments(query),
  ]);

  res.json({
    success: true,
    data: tasks,
    totalTasks: total,
    currentPage: page,
    totalPages: Math.ceil(total / limit),
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

// ---------------------------------------------------------
// TOGGLE COMPLETION
// ---------------------------------------------------------
// export const toggleTaskCompletion = handleAsync(async (req, res, next) => {
//   const { id } = req.params;
//   const { completeStatus } = req.body;

//   const updateData = {
//     completeStatus: completeStatus,
//     updatedBy: req.user._id,
//   };

//   if (completeStatus) {
//     updateData.status = "Completed";
//     updateData.taskDoneBy = req.user._id;
//     updateData.completedAt = new Date();
//   } else {
//     updateData.status = "Pending";
//     updateData.taskDoneBy = null;
//     updateData.completedAt = null;
//   }

//   const task = await Task.findByIdAndUpdate(id, updateData, { new: true });
//   if (!task) return next(new AppError("Task not found", 404));

//   res.status(200).json({
//     success: true,
//     data: normalizeTask(task),
//   });
// });
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
      deletedBy: req.user?._id || null,
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

export const importTasks = handleAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("No file uploaded.", 400));
  }

  const filePath = path.join(process.cwd(), "uploads", req.file.filename);
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
        "duedate",
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
          isDependent: isDependentStr,
          "Attachment File": attachmentFile,
          "Check List": checkListStr, // Added checklist
          // Fields for different task types
          Frequency: frequency,
          "Task ID": parentTaskId,
          "Start Time Setting": startTimeSetting,
          "X Value": xValue,
        } = row;

        // Trim whitespace from string fields
        const trimmedStartDateStr = startDateStr
          ? String(startDateStr).trim()
          : "";
        const trimmedDueDateStr = dueDateStr ? String(dueDateStr).trim() : "";
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
        const startDate = trimmedStartDateStr
          ? parseDateIST(trimmedStartDateStr)
          : null;
        const dueDate = trimmedDueDateStr
          ? parseDateIST(trimmedDueDateStr)
          : null;

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
            attachmentFile: finalAttachmentPath,
            isDependent,
            departmentOfAssignToUser: department._id, // <--- Department is now from the single lookup
            checklist,
          };

          let taskInstance;

          // Delegation vs Recurring vs Dependent
          if (isDependent) {
            // Find parent task
            const parentTask = await Task.findOne({
              TaskId: trimmedParentTaskId,
            });
            if (!parentTask)
              throw new Error(
                `Parent task with ID "${trimmedParentTaskId}" not found.`,
              );

            // Duplicate check for dependent tasks: same title + same assigned user + same parent
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
              dependencyConfig: {
                taskDependent: parentTask._id,
                startTimeSetting:
                  trimmedStartTimeSetting === "Planned to Planned"
                    ? "planned-to-planned"
                    : "actual-to-planned",
                isDependentFrequency: depFreqNormalized,
                xValue: trimmedXValue ? Number(trimmedXValue) : 1,
              },
            });
          } else if (trimmedFrequency) {
            // Recurring Task
            taskInstance = new RecurringTask({
              ...taskData,
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
    status, // <--- We capture this explicitly to check later
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
  await createLog({
    action: "UPDATE",
    module: "TASK",
    documentId: task._id,
    performedBy: req.cookies.userId,
    oldData,
    newData: task,
    message: `Task Updated | Title: ${task.title} | ID: ${task.TaskId}`,
  });
  // =========================================================
  //  MAGIC LOGIC: ACTUAL-TO-PLANNED TRIGGER
  //  (This runs AFTER the main task is successfully saved)
  // =========================================================
  if (task.completeStatus === true) {
    const dependentTasks = await Task.find({
      "dependencyConfig.taskDependent": task._id,
      "dependencyConfig.startTimeSetting": "actual-to-planned",
    });

    for (const depTask of dependentTasks) {
      let start = new Date(); // completion trigger time

      const x = Number(depTask.dependencyConfig.xValue || 0);
      const freq = (
        depTask.dependencyConfig.isDependentFrequency || ""
      ).toLowerCase();

      if (freq.includes("hour")) {
        start.setHours(start.getHours() + x);
      } else {
        start.setDate(start.getDate() + x);
      }

      const assignedUser = await User.findById(depTask.assignedTo).populate(
        "workShift",
      );

      start = applyWorkShift(start, assignedUser.assignShift);

      depTask.startDate = start;

      // optional dueDate
      if (depTask.taskEndDays) {
        let due = new Date(start);
        due.setDate(due.getDate() + depTask.taskEndDays);
        depTask.dueDate = applyWorkShift(due, assignedUser.assignShift);
      }

      await depTask.save();
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
