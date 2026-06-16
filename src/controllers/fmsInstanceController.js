import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsTemplate from "../models/FmsTemplate.js";
import FmsTask from "../models/FmsTask.js";
import User from "../models/User.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import fmsDateCalculator from "../utils/fmsDateCalculator.js";
import {
  addWorkingDaysHoliday,
  nextWorkingShiftDate,
  snapToShiftTime,
} from "../utils/dateCalculator.js";
import { generateRecurringFmsTasks } from "../cron/assignRecurringFmsTask.js";
const RECURRING_FREQUENCIES = ["Daily", "Weekly", "Monthly"];
import { isFmsTaskFullyComplete } from "../utils/fmsTaskValidator.js";
import { createLog } from "./logController.js";
import { updateTaskStatuses } from "../cron/taskStatusUpdate.js";
import { updateInstanceProgress } from "../cron/fmsInstanceTaskProgressCron.js";
import Counter from "../models/Counter.js";
import { addDays } from "date-fns";
import { sendNotification } from "../services/telegram/services/taskTelegramService.js";
const calculateInstanceStatus = (startDate) => {
  const now = new Date();

  if (startDate && now < startDate) {
    return "Upcoming";
  }

  return "Ongoing";
};
//**TO LAUNCH FMS */
export const launchFmsInstance = handleAsync(async (req, res, next) => {
  const { templateId } = req.params;
  const { launchDate: launchDateStr, endDate } = req.body;

  const userId = req.cookies.userId || req.user._id || null;
  const template = await FmsTemplate.findById(templateId).populate([
    "manager",
    "srManager",
  ]);
  if (!template) return next(new AppError("Template not found", 404));
  const taskCount = await FmsTask.countDocuments({ fmsTemplateId: templateId });
  if (taskCount === 0) {
    return next(
      new AppError("Cannot launch FMS: No tasks found in this template", 400),
    );
  }
  // 🔒 CHECK BEFORE CREATING INSTANCE
  // const existingInstance = await FmsInstance.findOne({
  //   fmsTemplateId: templateId,
  //   status: { $in: ["Upcoming", "Ongoing"] },
  // });

  // if (existingInstance) {
  //   return next(
  //     new AppError(
  //       `FMS already launched (Instance: ${existingInstance.instanceName})`,
  //       400,
  //     ),
  //   );
  // }
  const launchDate = new Date(launchDateStr || Date.now());
  const instanceEnd =
    template.fmsDuration === "Fixed Period" ? template.endDate : null;
  // console.log(template)
  const parsedEndDate =
    template.fmsDuration === "Fixed Period"
      ? endDate
        ? new Date(endDate)
        : template.endDate
      : launchDate;
  const normalizeDateOnly = (d) => {
    const date = new Date(d);
    date.setHours(0, 0, 0, 0);
    return date;
  };
  const launchDateValidation = normalizeDateOnly(launchDateStr || Date.now());
  const parsedEndDateValidation = endDate ? normalizeDateOnly(endDate) : null;

  // validation
  if (
    template.fmsDuration === "Fixed Period" &&
    parsedEndDate &&
    launchDateValidation > parsedEndDateValidation
  ) {
    return next(
      new AppError("Launch date cannot be greater than end date", 400),
    );
  }
  const status = calculateInstanceStatus(launchDate, parsedEndDate);
  // Create instance
  const counter = await Counter.findOneAndUpdate(
    {
      _id: "fms_instance",
    },
    {
      $inc: {
        seq: 1,
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  const sequence = String(counter.seq).padStart(5, "0");
  const managerUser = await User.findById(template.manager._id).populate(
    "assignShift",
  );
  let instanceStartDate = launchDate;
  let instanceEndDate = endDate ? new Date(endDate) : instanceEnd;

  if (managerUser?.assignShift) {
    instanceStartDate = await nextWorkingShiftDate(
      launchDate,
      managerUser.assignShift._id,
    );

    if (instanceEndDate) {
      instanceEndDate = snapToShiftTime(
        instanceEndDate,
        managerUser.assignShift,
        false, // shift end time
      );
    }
  }
  // const instanceCode = `FMS-${new Date().getFullYear()}-${sequence}`;
  const instance = await FmsInstance.create({
    fmsTemplateId: template._id,
    instanceName: `${template.templateName}`,
    startDate: instanceStartDate,
    endDate: instanceEndDate,
    manager: template.manager._id,
    srManager: template.srManager?._id || null,
    createdBy: userId,
    fmsDuration: template.fmsDuration,
    status,
    // instanceCode
  });

  // Get template tasks IN ORDER
  const templateTasks = await FmsTask.find({ fmsTemplateId: templateId }).sort(
    "taskId",
  );
  const instanceTasks = [];

  console.log("🚀 LAUNCHING FMS with", templateTasks.length, "tasks");

  for (let i = 0; i < templateTasks.length; i++) {
    const tmplTask = templateTasks[i];
    //**skip recurrent task creation */
    if (RECURRING_FREQUENCIES.includes(tmplTask.frequency)) {
      console.log(`⏭️ Skipping recurring task: ${tmplTask.taskId}`);
      continue;
    }

    const prevTasks = instanceTasks.slice(0, i);

    console.log(
      `${i + 1}. ${tmplTask.taskId}: ${tmplTask.frequency} x=${tmplTask.xValue} dep=${tmplTask.dependentOn}`,
    );

    // Get doer
    const doer = await User.findById(tmplTask.assignedTo).populate(
      "assignShift",
    );

    let dates = {
      startDate: null,
      dueDate: null,
    };
    const freq = (tmplTask.frequency || "").trim().toLowerCase();
    const parentTemplate = tmplTask.dependentOn
      ? await FmsTask.findOne({
          taskId: tmplTask.dependentOn,
        })
      : null;

    const isRecurringParent =
      parentTemplate &&
      RECURRING_FREQUENCIES.includes(parentTemplate.frequency);
    if (tmplTask.isDependent && isRecurringParent) {
      console.log(
        `⏭️ Skipping ${tmplTask.taskId} because parent ${parentTemplate.taskId} is recurring`,
      );

      continue;
    }
    if (freq === "anytime") {
      const shiftStart = doer.assignShift
        ? await nextWorkingShiftDate(launchDate, doer.assignShift._id)
        : launchDate;

      let dueDate = parsedEndDate;

      if (parsedEndDate && doer.assignShift) {
        dueDate = snapToShiftTime(
          parsedEndDate,
          doer.assignShift,
          false, // shift end
        );
      }

      dates = {
        startDate: shiftStart,
        dueDate,
      };
    } else if (!tmplTask.isDependent && freq.startsWith("start")) {
      const shiftStart = doer.assignShift
        ? await nextWorkingShiftDate(launchDate, doer.assignShift._id)
        : launchDate;

      let dueDate = shiftStart;

      if (freq.includes("hour")) {
        dueDate = new Date(
          shiftStart.getTime() + (tmplTask.xValue || 0) * 60 * 60 * 1000,
        );
      } else {
        const targetDate = addDays(shiftStart, tmplTask.xValue || 0);

        dueDate = doer.assignShift
          ? await nextWorkingShiftDate(targetDate, doer.assignShift._id)
          : targetDate;
      }

      dates = {
        startDate: shiftStart,
        dueDate,
      };
    } else if (!tmplTask.isDependent && freq.startsWith("event")) {
      if (!parsedEndDate) {
        throw new Error(
          `Event based task "${tmplTask.taskId}" requires FMS End Date`,
        );
      }

      const shiftStart = doer.assignShift
        ? await nextWorkingShiftDate(launchDate, doer.assignShift._id)
        : launchDate;

      let dueDate;
      const isNegative = freq.includes("event-x");
      const isPositive = freq.includes("event+x");
      const multiplier = isNegative ? -1 : 1;

      // EVENT HOURS
      if (freq.includes("hour")) {
        if (isNegative) {
          dueDate = new Date(
            parsedEndDate.getTime() +
              (tmplTask.xValue || 0) * 60 * 60 * 1000 * -1,
          );
        }
        if (isPositive) {
          dueDate = new Date(
            parsedEndDate.getTime() + (tmplTask.xValue || 0) * 60 * 60 * 1000,
          );
        }
        // const base = new Date(
        //   parsedEndDate.getTime() +
        //     Math.abs(tmplTask.xValue || 0) * 60 * 60 * 1000 * multiplier,
        // );

        // dueDate = doer.assignShift
        //   ? snapToShiftTime(
        //       await nextWorkingShiftDate(base, doer.assignShift._id),
        //       doer.assignShift,
        //       false,
        //     )
        //   : base;
      }

      // EVENT DAYS
      else {
        const targetDate = addDays(
          parsedEndDate,
          Math.abs(tmplTask.xValue || 0) * multiplier,
        );

        dueDate = doer.assignShift
          ? snapToShiftTime(
              await nextWorkingShiftDate(targetDate, doer.assignShift._id),
              doer.assignShift,
              false,
            )
          : targetDate;
      }

      dates = {
        startDate: shiftStart,
        dueDate,
      };
    }

    // ======================================================
    // PLANNED TO PLANNED (FIXED) -- Gloabl changes
    // ======================================================
    // else if (
    //   tmplTask.startTimeSetting === "planned-to-planned" &&
    //   tmplTask.isDependent
    // ) {
    //   let parent =
    //     prevTasks.find((t) => t.taskId === tmplTask.dependentOn) ||
    //     templateTasks.find((t) => t.taskId === tmplTask.dependentOn) ||
    //     (await FmsTask.findOne({ taskId: tmplTask.dependentOn }));

    //   if (!parent) {
    //     console.log(`❌ Parent not found for ${tmplTask.taskId}`);
    //     continue; // IMPORTANT: avoid crash
    //   }

    //   const parentDateRaw =
    //     parent.plannedDueDate || parent.plannedStartDate || launchDate;

    //   if (!parentDateRaw || isNaN(new Date(parentDateRaw).getTime())) {
    //     console.log(`❌ Invalid parent date for ${tmplTask.taskId}`);
    //     continue;
    //   }

    //   const parentDate = new Date(parentDateRaw);

    //   const x = Number(tmplTask.xValue || 0);
    //   const freq = (tmplTask.frequency || "").toLowerCase();
    //   const isNegative = freq.includes("task-x");
    //   const isPositive = freq.includes("task+x");
    //   let childStart;

    //   // =========================
    //   // HOURS (SAFE + FIXED)
    //   // =========================
    //   if (freq.includes("hour")) {
    //     if (isNegative) {
    //       childStart = new Date(
    //         parentDate.getTime() + (x || 0) * 60 * 60 * 1000 * -1,
    //       );
    //     }
    //     if (isPositive) {
    //       childStart = new Date(
    //         parentDate.getTime() + (x || 0) * 60 * 60 * 1000,
    //       );
    //     }
    //   }

    //   // =========================
    //   // DAYS (SAFE + FIXED)
    //   // =========================
    //   else {
    //     childStart = addDays(parentDate, x * isNegative);

    //     // preserve time
    //     childStart.setHours(
    //       parentDate.getHours(),
    //       parentDate.getMinutes(),
    //       parentDate.getSeconds(),
    //       parentDate.getMilliseconds(),
    //     );
    //   }

    //   let startDate = childStart;
    //   let dueDate = null;

    //   // =========================
    //   // SHIFT SAFETY (NO INVALID DATE)
    //   // =========================
    //   if (doer.assignShift && startDate instanceof Date && !isNaN(startDate)) {
    //     const shiftStart = snapToShiftTime(startDate, doer.assignShift, true);
    //     const shiftEnd = snapToShiftTime(startDate, doer.assignShift, false);

    //     if (startDate < shiftStart) {
    //       startDate = shiftStart;
    //     }

    //     if (startDate >= shiftEnd) {
    //       const next = new Date(startDate);
    //       next.setDate(next.getDate() + 1);

    //       startDate = await nextWorkingShiftDate(next, doer.assignShift._id);
    //     }
    //   }

    //   // =========================
    //   // FORCE SAME-DAY SHIFT END DUE DATE
    //   // =========================
    //   // let dueDate = null;

    //   if (doer.assignShift && startDate) {
    //     // Take shift end of SAME DAY as startDate
    //     dueDate = snapToShiftTime(startDate, doer.assignShift, false);

    //     // Safety: ensure same calendar day
    //     const startDay = new Date(startDate);
    //     const dueDay = new Date(dueDate);

    //     if (startDay.toDateString() !== dueDay.toDateString()) {
    //       // if shift end pushed to next day (edge case), clamp it back
    //       dueDate = new Date(startDay);
    //       const [h, m] = doer.assignShift.endTime.split(":").map(Number);
    //       dueDate.setHours(h, m, 0, 0);
    //     }
    //   }

    //   dates = {
    //     startDate,
    //     dueDate: dueDate || null,
    //   };
    // }

    //**HIMAIRA MIS CHANGE */
    else if (
      tmplTask.startTimeSetting === "planned-to-planned" &&
      tmplTask.isDependent
    ) {
      let parent =
        prevTasks.find((t) => t.taskId === tmplTask.dependentOn) ||
        templateTasks.find((t) => t.taskId === tmplTask.dependentOn) ||
        (await FmsTask.findOne({ taskId: tmplTask.dependentOn }));

      if (!parent) {
        console.log(`❌ Parent not found for ${tmplTask.taskId}`);
        continue;
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
      const parentStart = parent.plannedStartDate;
      const parentDue = parent.plannedDueDate;
      let startDate;
      let dueDate;
      if (!parentStart || !parentDue) {
        console.log(`❌ Parent dates missing for ${tmplTask.taskId}`);
        continue;
      }
      const isSameShift =
        String(doer.assignShift?._id) === String(parentWorkShift?._id);
      if (!isSameShift) {
        console.log("⚠️ Shift mismatch → using child shift window only");

        const baseDate = new Date(parentStart);

        const start = await nextWorkingShiftDate(
          baseDate,
          doer.assignShift._id,
        );

        startDate = snapToShiftTime(start, doer.assignShift, true);
        dueDate = snapToShiftTime(start, doer.assignShift, false);

        // ❗ DO NOT return
        // just skip dependency math
      } else {
        const x = Number(tmplTask.xValue || 0);
        const freq = (tmplTask.frequency || "").toLowerCase();

        // ====================================
        // CHILD START = SAME AS PARENT START
        // ====================================
        startDate = new Date(parentStart);

        dueDate = new Date(parentDue);

        // ====================================
        // HOURS
        // ====================================
        if (freq.includes("hour")) {
          let calculatedDue = new Date(parentDue);

          // Parent due + X hours
          calculatedDue.setHours(calculatedDue.getHours() + x);

          const shiftEnd = snapToShiftTime(parentDue, doer.assignShift, false);

          if (calculatedDue < shiftEnd) {
            dueDate = calculatedDue;
          } else {
            // overflow after shift end
            const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();

            let nextDay = new Date(parentDue);
            nextDay.setDate(nextDay.getDate() + 1);

            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              doer.assignShift._id,
            );

            const nextShiftStart = snapToShiftTime(
              nextWorkingDay,
              doer.assignShift,
              true,
            );

            dueDate = new Date(nextShiftStart.getTime() + overflowMs);
          }
        }

        // ====================================
        // DAYS
        // ====================================
        else {
          dueDate = await addWorkingDaysHoliday(
            parentDue,
            x,
            doer.assignShift._id,
          );

          dueDate.setHours(
            parentDue.getHours(),
            parentDue.getMinutes(),
            parentDue.getSeconds(),
            parentDue.getMilliseconds(),
          );

          const shiftEnd = snapToShiftTime(dueDate, doer.assignShift, false);

          if (dueDate >= shiftEnd) {
            let nextDay = new Date(dueDate);
            nextDay.setDate(nextDay.getDate() + 1);

            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              doer.assignShift._id,
            );

            // move to next working day shift END
            dueDate = snapToShiftTime(nextWorkingDay, doer.assignShift, false);
          }
        }
      }
      dates = {
        startDate,
        dueDate,
      };
    }
    // ======================================================
    // NO DEPENDENCY
    // ======================================================
    else if (!tmplTask.isDependent) {
      dates = await fmsDateCalculator.calculateFmsTaskDates(
        tmplTask.toObject(),
        launchDate,
        parsedEndDate,
        doer.assignShift?._id,
        prevTasks.map((t) => ({
          taskId: t.taskId,
          plannedDueDate: t.plannedDueDate,
          plannedStartDate: t.plannedStartDate,
        })),
      );
    }

    // ======================================================
    // PLANNED TO PLANNED
    // ======================================================
    // else if (tmplTask.startTimeSetting === "planned-to-planned") {
    //   dates = await fmsDateCalculator.calculateFmsTaskDates(
    //     tmplTask.toObject(),
    //     launchDate,
    //     parsedEndDate,
    //     doer.assignShift?._id,
    //     prevTasks.map((t) => ({
    //       taskId: t.taskId,
    //       plannedDueDate: t.plannedDueDate,
    //       plannedStartDate: t.plannedStartDate,
    //     })),
    //   );
    // }

    // ======================================================
    // ACTUAL TO PLANNED
    // ======================================================
    else if (tmplTask.startTimeSetting === "actual-to-planned") {
      dates = {
        startDate: null,
        dueDate: null,
      };
    }

    const instanceTaskData = {
      fmsInstanceId: instance._id,
      fmsTaskId: tmplTask._id,

      taskId: tmplTask.taskId,
      description: tmplTask.description,

      departmentOfAssignToUser: tmplTask.departmentOfAssignToUser,

      assignedTo: tmplTask.assignedTo,
      assignedBy: tmplTask.assignedBy,

      frequency: tmplTask.frequency,

      xValue: tmplTask.xValue,

      isDependent: tmplTask.isDependent,
      dependentOn: tmplTask.dependentOn,
      startTimeSetting: tmplTask.startTimeSetting,

      decisionStep: tmplTask.decisionStep,
      ifTrueStep: tmplTask.ifTrueStep,
      elseStep: tmplTask.elseStep,

      taskEndDays: tmplTask.taskEndDays || 0,

      plannedStartDate: dates.startDate,
      plannedDueDate: dates.dueDate,

      status:
        tmplTask.startTimeSetting === "actual-to-planned"
          ? "Upcoming"
          : calculateTaskStatus(dates.startDate, dates.dueDate),

      isVisible: false,

      updatedBy: userId,

      checklist: tmplTask.checklist || [],

      createdForm: tmplTask.createdForm || [],
    };

    // ======================================================
    // WAIT FOR PARENT
    // ======================================================

    if (
      freq !== "anytime" &&
      tmplTask.isDependent &&
      tmplTask.startTimeSetting === "actual-to-planned"
    ) {
      instanceTaskData.waitingForParent = true;
    }

    const instanceTask = new FmsInstanceTask(instanceTaskData);

    await instanceTask.save();

    sendNotification({
      type: "TASK_ASSIGNED",
      task: instanceTask,
      actor: req.user,
    });
    instanceTasks.push(instanceTask);

    console.log(
      `✅ ${instanceTask.taskId} -> start=${instanceTask.plannedStartDate} due=${instanceTask.plannedDueDate}`,
    );
  }
  await generateRecurringFmsTasks(instance._id);
  //**Set islaunched true for FMS template */
  await FmsTemplate.findByIdAndUpdate(templateId, {
    isLaunched: true,
  });
  await instance.populate(["manager", "srManager", "fmsTemplateId"]);
  // FIXED LOG - use valid enum
  // await createLog({
  //   action: 'CREATE',
  //   module: 'FMS_INSTANCE',
  //   performedBy: userId,
  //   documentId: instance._id,
  //   newData: {
  //     instanceId: instance.instanceId,
  //     taskCount: instanceTasks.length
  //   },
  //   message: `Launched FMS ${instance.instanceId} with ${instanceTasks.length} tasks`
  // });

  res.status(201).json({
    success: true,
    data: instance,
    tasks: instanceTasks.map((t) => ({
      taskId: t.taskId,
      plannedStartDate: t.plannedStartDate,
      plannedDueDate: t.plannedDueDate,
      status: t.status,
    })),
  });
});

//**UPDATE FMS TASKS */
export const updateFmsInstanceTask = handleAsync(async (req, res) => {
  const { id: instanceId, taskId: taskIdParam } = req.params;

  const task = await FmsInstanceTask.findOne({
    fmsInstanceId: instanceId,
    taskId: taskIdParam,
  });

  // ✅ 1. Handle not found
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  // ✅ 2. Safe updates
  if (req.body.checklist) {
    task.checklist = req.body.checklist;
  }

  if (req.body.formData) {
    task.formData = {
      ...(task.formData || {}),
      ...req.body.formData,
    };
  }

  // ✅ 3. Always calculate progress
  const checklistComplete = task.checklist?.length
    ? task.checklist.every((item) => item.completed)
    : true;

  // ✅ Check mandatory form fields properly
  const formsComplete = (task.createdForm || []).every((field) => {
    if (!field.isMandatory) return true;

    const value = task.formData?.[field.fieldName];

    // ❗ handle empty cases properly
    if (value === undefined || value === null || value === "") {
      return false;
    }

    return true;
  });

  // ✅ 4. Validate only when marking completed
  if (req.body.status === "Completed") {
    if (!checklistComplete || !formsComplete) {
      return res.status(400).json({
        error: "Checklist & mandatory forms required",
        checklistComplete,
        formsComplete,
      });
    }

    task.actualCompleteDate = new Date();
  }

  // ✅ 5. Update status
  if (req.body.status) {
    task.status = req.body.status;
  }

  await task.save();

  // ✅ 6. Better progress calculation
  const progress =
    ((Number(checklistComplete) + Number(formsComplete)) / 2) * 100;

  res.json({
    success: true,
    status: task.status,
    checklistComplete,
    formsComplete,
    progress: `${progress}%`,
  });
});

//**COMPLETE TASK */
export const completeInstanceTask = handleAsync(async (req, res, next) => {
  const { id: instanceId, taskId: taskIdParam } = req.params;
  const { status } = req.body;
  const task = await FmsInstanceTask.findOne({
    fmsInstanceId: instanceId,
    taskId: taskIdParam,
  });
  // .populate('assignedTo assignShift');

  if (!task) return next(new AppError("Task not found", 404));

  // Mark complete
  if (!isFmsTaskFullyComplete(task)) {
    return res.status(400).json({
      error: "Complete checklist and mandatory forms first",
    });
  }
  task.actualCompleteDate = new Date();
  task.status = "Completed";
  task.updatedBy = req.cookies.userId || req.user._id || null;
  await task.save();
  await updateInstanceProgress();
  // 🔥 FIND CHILDREN (reverse: who depends ON this parent)
  const children = await FmsInstanceTask.find({
    fmsInstanceId: instanceId,
    startTimeSetting: "actual-to-planned",
    dependentOn: task.taskId, // IMPORTANT LINK
    // waitingForParent: true,
  }).populate({
    path: "assignedTo",
    populate: { path: "assignShift" },
  });
  const assignedParentUser = await User.findById(task.assignedTo).populate(
    "assignShift",
  );
  if (!assignedParentUser) {
    return next(new AppError(`User with ID ${task.assignedTo} not found`, 404));
  }

  const parentWorkShift = assignedParentUser.assignShift;
  //**GLOBAL CHANGES */
  // for (const child of children) {
  //   try {
  //     const workShift = await User.findById(child.assignedTo).populate(
  //       "assignShift",
  //     );
  //     const shift = workShift?.assignShift;

  //     if (!shift) continue;

  //     const parentDate = new Date(task.actualCompleteDate);
  //     if (!parentDate || isNaN(parentDate)) continue;

  //     const x = Number(child.xValue || 0);
  //     const freq = (child.frequency || "").toLowerCase();

  //     let startDate = new Date(parentDate);

  //     // ======================================================
  //     // STEP 1: OFFSET FROM ACTUAL COMPLETION
  //     // ======================================================
  //     if (freq.includes("hour")) {
  //       if (freq.includes("task+x")) {
  //         startDate = new Date(
  //           parentDate.getTime() + (x || 0) * 60 * 60 * 1000,
  //         );
  //       } else {
  //         startDate = new Date(
  //           parentDate.getTime() + (x || 0) * 60 * 60 * 1000 * -1,
  //         );
  //       }
  //     } else {
  //       if (freq.includes("task+x")) {
  //         startDate = addDays(parentDate, x);
  //       } else {
  //         startDate = addDays(parentDate, -x);
  //       }
  //     }
  //     let rawStartDate = new Date(startDate); // 👈 STORE ORIGINAL BEFORE SHIFT LOGIC
  //     startDate = new Date(rawStartDate);

  //     // ======================================================
  //     // SHIFT BOUNDARY FIX
  //     // ======================================================

  //     const shiftStart = snapToShiftTime(startDate, shift, true);
  //     const shiftEnd = snapToShiftTime(startDate, shift, false);

  //     // if before shift start → push to shift start
  //     if (startDate < shiftStart) {
  //       startDate = shiftStart;
  //     }

  //     // if after shift end → move to next working day
  //     if (startDate >= shiftEnd) {
  //       const next = new Date(startDate);
  //       next.setDate(next.getDate() + 1);

  //       startDate = await nextWorkingShiftDate(next, shift._id);
  //       startDate = snapToShiftTime(startDate, shift, true);
  //     }

  //     // final corrected start
  //     // startDate = actualStart;
  //     // ======================================================
  //     // STEP 3: DUE DATE = SHIFT END
  //     // ======================================================
  //     let dueDate = snapToShiftTime(startDate, shift, false);

  //     if (!dueDate || isNaN(dueDate)) {
  //       const fallback = new Date(startDate);
  //       const [h, m] = shift.endTime.split(":").map(Number);
  //       fallback.setHours(h, m, 0, 0);
  //       dueDate = fallback;
  //     }

  //     // ======================================================
  //     // STEP 4: UPDATE CHILD
  //     // ======================================================
  //     child.plannedStartDate = startDate;
  //     child.plannedDueDate = dueDate;

  //     child.actualStartDate = rawStartDate;
  //     // child.actualDueDate = null;

  //     child.waitingForParent = false;
  //     child.status = calculateTaskStatus(startDate, dueDate);

  //     await child.save();

  //     console.log("UPDATED CHILD:", child.taskId, startDate, dueDate);
  //   } catch (err) {
  //     console.error("FAILED CHILD:", child.taskId, err);
  //   }
  // }
  //**HIMAIRA CHANGE */
  for (const child of children) {
    try {
      const workShift = await User.findById(child.assignedTo).populate(
        "assignShift",
      );
      const shift = workShift?.assignShift;

      if (!shift) continue;

      const parentStart = task.plannedStartDate;
      const parentDue = task.plannedDueDate;
      let startDate;
      let dueDate;
      if (!parentStart || !parentDue) continue;
      const isSameShift =
        String(shift?._id) === String(parentWorkShift?._id);
      if (!isSameShift) {
        console.log("⚠️ Shift mismatch → using child shift window only");

        const baseDate = new Date(parentStart);

        const start = await nextWorkingShiftDate(baseDate, shift._id);

        startDate = snapToShiftTime(start, shift, true);
        dueDate = snapToShiftTime(start, shift, false);

        // ❗ DO NOT return
        // just skip dependency math
      } else {
        const x = Number(child.xValue || 0);
        const freq = (child.frequency || "").toLowerCase();

        // ====================================
        // START DATE = PARENT START DATE
        // ====================================
        startDate = new Date(parentStart);

        dueDate = new Date(parentDue);

        // ====================================
        // HOURS
        // ====================================
        if (freq.includes("hour")) {
          let calculatedDue = new Date(parentDue);

          // parent due + x hours
          calculatedDue.setHours(calculatedDue.getHours() + x);

          const shiftEnd = snapToShiftTime(parentDue, shift, false);

          if (calculatedDue < shiftEnd) {
            dueDate = calculatedDue;
          } else {
            const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();

            let nextDay = new Date(parentDue);
            nextDay.setDate(nextDay.getDate() + 1);

            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              shift._id,
            );

            const nextShiftStart = snapToShiftTime(nextWorkingDay, shift, true);

            dueDate = new Date(nextShiftStart.getTime() + overflowMs);
          }
        }

        // ====================================
        // DAYS
        // ====================================
        else {
          dueDate = await addWorkingDaysHoliday(parentDue, x, shift._id);

          dueDate.setHours(
            parentDue.getHours(),
            parentDue.getMinutes(),
            parentDue.getSeconds(),
            parentDue.getMilliseconds(),
          );

          const shiftEnd = snapToShiftTime(dueDate, shift, false);

          if (dueDate >= shiftEnd) {
            let nextDay = new Date(dueDate);
            nextDay.setDate(nextDay.getDate() + 1);

            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              shift._id,
            );

            dueDate = snapToShiftTime(nextWorkingDay, shift, false);
          }
        }
      }
      // ====================================
      // UPDATE CHILD
      // ====================================
      child.plannedStartDate = startDate;
      child.plannedDueDate = dueDate;

      child.actualStartDate = null;
      child.waitingForParent = false;
      child.status = calculateTaskStatus(startDate, dueDate);

      await child.save();

      console.log("UPDATED CHILD:", child.taskId, startDate, dueDate);
    } catch (err) {
      console.error("FAILED CHILD:", child.taskId, err);
    }
  }
  res.json({
    success: true,
    message: `Task ${task.taskId} completed. Triggered ${children.length} children`,
  });
});
//**UPDATE FORMDATA FOR TASK */
export const updateFormData = async (req, res, next) => {
  try {
    const { id, taskId } = req.params;
    const userId = req.cookies.userId || req.user._id || null;
    const incomingData = req.body; // { fieldName: value }

    const task = await FmsInstanceTask.findOne({
      fmsInstanceId: id,
      taskId,
    });

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // ✅ Validate fields against createdForm
    const createdForm = task.createdForm || [];

    const updatedFormData = { ...(task.formData || {}) };

    for (const field of createdForm) {
      const value = incomingData[field.fieldName];

      if (value !== undefined) {
        // ✅ Basic type validation
        switch (field.fieldType) {
          case "number":
            if (isNaN(value)) {
              return res.status(400).json({
                success: false,
                message: `${field.fieldName} must be a number`,
              });
            }
            break;

          case "email":
            if (!/^\S+@\S+\.\S+$/.test(value)) {
              return res.status(400).json({
                success: false,
                message: `Invalid email for ${field.fieldName}`,
              });
            }
            break;

          case "url":
            try {
              new URL(value);
            } catch {
              return res.status(400).json({
                success: false,
                message: `Invalid URL for ${field.fieldName}`,
              });
            }
            break;

          default:
            break;
        }

        updatedFormData[field.fieldName] = value;

        // ✅ Mark field as completed
        field.completed = true;
      }
    }

    // ❗ Check mandatory fields
    for (const field of createdForm) {
      if (
        field.isMandatory &&
        (updatedFormData[field.fieldName] === undefined ||
          updatedFormData[field.fieldName] === "")
      ) {
        return res.status(400).json({
          success: false,
          message: `${field.fieldName} is required`,
        });
      }
    }

    // ✅ Save updates
    task.formData = updatedFormData;
    task.updatedBy = userId;
    task.markModified("createdForm"); // important for nested update
    task.markModified("formData");

    await task.save();

    return res.status(200).json({
      success: true,
      message: "Form data updated successfully",
      data: {
        taskId: task.taskId,
        formData: task.formData,
        createdForm: task.createdForm,
      },
    });
  } catch (error) {
    next(error);
  }
};
//**UPDATE CHECKLIST FOR TASK */
export const updateChecklistItem = handleAsync(async (req, res, next) => {
  const { id, taskId } = req.params;
  const userId = req.cookies.userId || req.user._id || null;
  const { index, completed } = req.body;

  const task = await FmsInstanceTask.findOne({
    fmsInstanceId: id,
    taskId,
  });
  const idx = parseInt(index);
  if (isNaN(idx) || idx < 0) {
    return next(new AppError("Invalid checklist index", 400));
  }
  const isCompleted = completed === true || completed === "true";

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

  task.checklist[idx].completed = isCompleted;
  task.updatedBy = userId;
  task.updatedAt = new Date();

  const updatedTask = await task.save();

  await createLog({
    action: "UPDATE_CHECKLIST",
    module: "TASK",
    documentId: task._id,
    performedBy: userId,
    oldData,
    newData: updatedTask,
    message: `Checklist item ${idx} updated to ${isCompleted ? "completed" : "pending"} | Task: ${task.title}`,
  });

  const progress =
    task.checklist.length > 0
      ? Math.round(
          (task.checklist.filter((item) => item.completed).length /
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
      taskId: task.taskId,
    },
  });
});
//**HOLD FMS INSTANCE */
export const holdFmsInstance = handleAsync(async (req, res) => {
  const instance = await FmsInstance.findById(req.params.id);
  const { reason } = req.body;
  const currentUser = req.cookies.userId || req.user._id || null;
  if (!instance) {
    return res.status(404).json({ message: "Instance not found" });
  }
  instance.status = "Onhold";
  instance.isStopped = true;

  // Only pause active tasks (not completed)
  await instance.save();
  await FmsInstanceTask.updateMany(
    {
      fmsInstanceId: instance._id,
      // status: { $nin: ["Completed", "Cancelled"] },
    },
    { status: "Onhold" },
  );
  // await FmsTemplate.findByIdAndUpdate(instance.fmsTemplateId, {
  //   fmsHoldReason: reason || "Manual stop",
  //   holdBy: currentUser,
  // });
  instance.holdReason = reason || "Manual hold";
  instance.holdBy = currentUser;

  await instance.save();
  res.json({ success: true, message: "FMS put on hold" });
});
//**RESUME FMS INSTANCE */
export const resumeFmsInstance = handleAsync(async (req, res) => {
  const instance = await FmsInstance.findById(req.params.id);
  const currentUser = req.cookies.userId || req.user._id || null;

  if (!instance) {
    return res.status(404).json({ message: "Instance not found" });
  }
  const newStatus = calculateInstanceStatus(
    instance.startDate,
    instance.endDate,
  );
  instance.status = newStatus;
  instance.isStopped = false;

  // Restore paused tasks
  await instance.save();
  await FmsInstanceTask.updateMany(
    {
      fmsInstanceId: instance._id,
      status: "Onhold",
    },
    {
      status: "Pending",
    },
  );
  await FmsTemplate.findByIdAndUpdate(instance.fmsTemplateId, {
    resumedBy: currentUser,
  });
  await updateTaskStatuses();
  await updateInstanceProgress();

  res.json({ success: true, message: "FMS resumed successfully" });
});
//**STOP FMS INSTANCE */
export const stopFmsInstance = handleAsync(async (req, res) => {
  const instance = await FmsInstance.findById(req.params.id);
  const { reason } = req.body;
  const currentUser = req.cookies.userId || req.user._id || null;
  if (!instance) {
    return res.status(404).json({ message: "Instance not found" });
  }

  instance.status = "Stopped";
  instance.isStopped = true;

  await instance.save();
  // Stop all non-completed tasks
  await FmsInstanceTask.updateMany(
    {
      fmsInstanceId: instance._id,
      // status: { $nin: ["Completed", "Cancelled"] },
    },
    {
      status: "Stopped",
    },
  );
  // await FmsTemplate.findByIdAndUpdate(instance.fmsTemplateId, {
  //   fmsStoppedReason: reason || "Manual stop",
  //   stoppedBy: currentUser,
  // });
  instance.stoppedReason = reason || "Manual stop";
  instance.stoppedBy = currentUser;

  await instance.save();
  res.json({ success: true, message: "FMS stopped permanently" });
});

//**GET LAUNCHED FMS */
export const getFmsInstances = handleAsync(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    search = "",
    status,
    instanceId,
    instanceName,
  } = req.body;
  const userId = req.cookies.userId || req.user?._id;

  // Build query
  const query = { createdBy: userId };

  // Search by instanceId OR instanceName
  if (search) {
    query.$or = [
      { instanceId: { $regex: search, $options: "i" } },
      { instanceName: { $regex: search, $options: "i" } },
    ];
  }

  // Filter by instanceId
  if (instanceId) {
    query.instanceId = { $regex: instanceId, $options: "i" };
  }

  // Filter by instanceName
  if (instanceName) {
    query.instanceName = { $regex: instanceName, $options: "i" };
  }

  // Status filter (upcoming, ongoing, completed)
  if (
    status &&
    ["upcoming", "ongoing", "completed", "onhold", "stopped"].includes(
      status.toLowerCase(),
    )
  ) {
    const statusMap = {
      upcoming: "Upcoming",
      ongoing: { $in: ["Ongoing", "InProcess"] },
      completed: { $in: ["Completed", "Cancelled"] },
      onhold: { $in: ["Onhold"] },
      stopped: { $in: ["Stopped"] },
    };
    query.status = statusMap[status.toLowerCase()];
  }

  // Pagination
  const skip = (Number(page) - 1) * Number(limit);
  const total = await FmsInstance.countDocuments(query);

  const instances = await FmsInstance.find(query)
    .populate(
      "fmsTemplateId manager srManager createdBy",
      "templateName fmsId name email",
    )
    .sort({ startDate: -1, createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  res.json({
    success: true,
    data: instances,
    pagination: {
      current: Number(page),
      pages: Math.ceil(total / Number(limit)),
      total,
      limit: Number(limit),
    },
  });
});
//**GET FMS COUNTS FOR DASHBOARD */
export const getFmsInstancesCount = handleAsync(async (req, res) => {
  const matchStage = {};

  const result = await FmsInstance.aggregate([
    { $match: matchStage },

    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
      },
    },
  ]);

  // Normalize response
  const counts = {
    upcoming: 0,
    ongoing: 0,
    completed: 0,
    onhold: 0,
    stopped: 0,
    total: 0,
  };

  result.forEach((item) => {
    const status = item._id;

    if (status === "Upcoming") counts.upcoming += item.count;

    if (["Ongoing", "InProcess"].includes(status)) counts.ongoing += item.count;

    if (["Completed", "Cancelled"].includes(status))
      counts.completed += item.count;

    if (status === "Onhold") counts.onhold += item.count;

    if (status === "Stopped") counts.stopped += item.count;

    counts.total += item.count;
  });

  res.json({
    success: true,
    data: counts,
  });
});
//**GET LAUNCHED FMS BY ID */
export const getFmsInstanceById = handleAsync(async (req, res, next) => {
  const instance = await FmsInstance.findById(req.params.id)
    .populate("srManager", "name email")
    .populate("manager", "name email");
  if (!instance) return next(new AppError("Instance not found", 404));
  res.json({ success: true, data: instance });
});

//**GET FMS INSTANCE TASK BY ID */
export const getFMSInstanceTaskById = handleAsync(async (req, res, next) => {
  const { id } = req.params;

  const task = await FmsInstanceTask.findById(id)
    .populate("assignedTo", "name email department assignShift")
    .populate("assignedBy", "name email")
    .populate("updatedBy", "name email") // use as assignedBy fallback
    .populate("departmentOfAssignToUser", "name");
  if (!task) return next(new AppError("Task not found", 404));

  res.status(200).json({
    success: true,
    data: task,
  });
});

//**GET TASKS OF LAUNCHED FMS */
export const getInstanceTasks = handleAsync(async (req, res) => {
  const tasks = await FmsInstanceTask.find({ fmsInstanceId: req.params.id })
    .populate({
      path: "fmsInstanceId",
      select: "instanceName status progress",
    })
    .populate({
      path: "fmsTaskId",
      select: "taskId assignedBy", // only what you need
      populate: {
        path: "assignedBy",
        select: "name email",
      },
    })
    .populate({
      path: "assignedTo",
      select: "name email",
    })
    .populate({
      path: "departmentOfAssignToUser",
      select: "name",
    })
    .populate({
      path: "updatedBy",
      select: "name",
    })
    .sort("taskId");
  res.json({ success: true, data: tasks });
});

//** helper functions */
const calculateTaskStatus = (startDate, dueDate) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!startDate) return "Upcoming";
  const s = new Date(startDate);
  if (s > today) return "Upcoming";

  if (dueDate) {
    const d = new Date(dueDate);
    if (d < today) return "Overdue";
    if (d.toDateString() === today.toDateString()) return "Delayed";
  }
  return "Pending";
};
