import FmsInstance from "../models/FmsInstance.js";
import mongoose from "mongoose";
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
import { startOfDay, endOfDay, addDays, format } from "date-fns";
import { sendNotification } from "../services/telegram/services/taskTelegramService.js";
import Role from "../models/Role.js";

const calculateInstanceStatus = (startDate) => {
  const now = new Date();

  if (startDate && now < startDate) {
    return "Upcoming";
  }

  return "Ongoing";
};

//**TO LAUNCH FMS (MANUAL / DIRECT LAUNCH) */
export const launchFmsInstance = handleAsync(async (req, res, next) => {
  const { templateId } = req.params;
  const { launchDate: launchDateStr, endDate } = req.body;

  const userId = req.cookies?.userId || req.user?._id || null;
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

  const launchDate = new Date(launchDateStr || Date.now());
  const instanceEnd =
    template.fmsDuration === "Fixed Period" ? template.endDate : null;

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

  // Validation
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

  // Counter
  const counter = await Counter.findOneAndUpdate(
    { _id: "fms_instance" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );

  const sequence = String(counter.seq).padStart(5, "0");

  let instanceStartDate = launchDate;
  let instanceEndDate = endDate ? new Date(endDate) : instanceEnd;

  // Create FmsInstance
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
  });

  // Fetch Template Tasks in sequential order
  const templateTasks = await FmsTask.find({ fmsTemplateId: templateId }).sort(
    "taskId",
  );
  const instanceTasks = [];

  console.log("🚀 LAUNCHING FMS with", templateTasks.length, "tasks");

  for (let i = 0; i < templateTasks.length; i++) {
    const tmplTask = templateTasks[i];

    // Skip recurring root task template creation at launch
    if (RECURRING_FREQUENCIES.includes(tmplTask.frequency)) {
      console.log(`⏭️ Skipping recurring task template: ${tmplTask.taskId}`);
      continue;
    }

    const prevTasks = instanceTasks.slice(0, i);

    console.log(
      `${i + 1}. ${tmplTask.taskId}: ${tmplTask.frequency} x=${tmplTask.xValue} dep=${tmplTask.dependentOn}`,
    );

    // Fetch assigned Doer
    const doer = await User.findById(tmplTask.assignedTo).populate(
      "assignShift",
    );

    // Priority given to task's direct department context
    const taskDeptContext =
      tmplTask.departmentOfAssignToUser || doer?.department || doer?._id;

    let dates = {
      startDate: null,
      dueDate: null,
    };
    const freq = (tmplTask.frequency || "").trim().toLowerCase();

    const parentTemplate = tmplTask.dependentOn
      ? await FmsTask.findOne({ taskId: tmplTask.dependentOn })
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

    // 🟢 HANDLE "LINKED WITH FORM" TASKS DURING MANUAL LAUNCH (Treated as Normal Task without X-Value offset)
    if (tmplTask.linkedWithForm === true || freq.startsWith("form event")) {
      const shiftStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : launchDate;

      let dueDate = doer?.assignShift
        ? snapToShiftTime(shiftStart, doer.assignShift, false)
        : shiftStart;

      dates = {
        startDate: shiftStart,
        dueDate,
      };
    }
    // 🟢 STANDARD WORKFLOW: HANDLE NORMAL TASKS
    else if (freq === "none" || freq === "") {
      const shiftStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : launchDate;

      let dueDate = doer?.assignShift
        ? snapToShiftTime(shiftStart, doer.assignShift, false)
        : shiftStart;

      dates = {
        startDate: shiftStart,
        dueDate,
      };
    } else if (freq === "anytime") {
      const shiftStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : launchDate;

      let dueDate = parsedEndDate;

      if (parsedEndDate && doer?.assignShift) {
        dueDate = snapToShiftTime(parsedEndDate, doer.assignShift, false);
      }

      dates = {
        startDate: shiftStart,
        dueDate,
      };
    } else if (!tmplTask.isDependent && freq.startsWith("start")) {
      const shiftStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : launchDate;

      let dueDate = shiftStart;

      if (freq.includes("hour")) {
        dueDate = new Date(
          shiftStart.getTime() + (tmplTask.xValue || 0) * 60 * 60 * 1000,
        );
      } else {
        const targetDate = addDays(shiftStart, tmplTask.xValue || 0);

        dueDate = doer?.assignShift
          ? await nextWorkingShiftDate(
              targetDate,
              doer.assignShift._id,
              {},
              taskDeptContext,
            )
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

      const shiftStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : launchDate;

      let dueDate;
      const isNegative = freq.includes("event-x");
      const isPositive = freq.includes("event+x");
      const multiplier = isNegative ? -1 : 1;

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
      } else {
        const targetDate = addDays(
          parsedEndDate,
          Math.abs(tmplTask.xValue || 0) * multiplier,
        );

        dueDate = doer?.assignShift
          ? snapToShiftTime(
              await nextWorkingShiftDate(
                targetDate,
                doer.assignShift._id,
                {},
                taskDeptContext,
              ),
              doer.assignShift,
              false,
            )
          : targetDate;
      }

      dates = {
        startDate: shiftStart,
        dueDate,
      };
    } else if (
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
      const rawParentStart = parent.plannedStartDate;
      const rawParentDue = parent.plannedDueDate;

      const parentStart = doer?.assignShift
        ? await nextWorkingShiftDate(
            rawParentStart || launchDate,
            doer.assignShift._id,
            {},
            taskDeptContext,
          )
        : rawParentStart || launchDate;

      const parentDue = doer?.assignShift
        ? snapToShiftTime(rawParentDue || parentStart, doer.assignShift, false)
        : rawParentDue || parentStart;

      let startDate;
      let dueDate;

      const isSameShift =
        String(doer?.assignShift?._id) === String(parentWorkShift?._id);

      if (!isSameShift) {
        console.log("⚠️ Shift mismatch → using child shift window only");

        const baseDate = new Date(parentStart);

        const start = await nextWorkingShiftDate(
          baseDate,
          doer.assignShift._id,
          {},
          taskDeptContext,
        );

        startDate = snapToShiftTime(start, doer.assignShift, true);
        dueDate = snapToShiftTime(start, doer.assignShift, false);
      } else {
        const x = Number(tmplTask.xValue || 0);
        const freq = (tmplTask.frequency || "").toLowerCase();

        startDate = new Date(parentStart);
        dueDate = new Date(parentDue);

        if (freq.includes("hour")) {
          let calculatedDue = new Date(parentDue);
          calculatedDue.setHours(calculatedDue.getHours() + x);

          const shiftEnd = snapToShiftTime(parentDue, doer.assignShift, false);

          if (calculatedDue < shiftEnd) {
            dueDate = calculatedDue;
          } else {
            const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();
            let nextDay = new Date(parentDue);
            nextDay.setDate(nextDay.getDate() + 1);

            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              doer.assignShift._id,
              {},
              taskDeptContext,
            );

            const nextShiftStart = snapToShiftTime(
              nextWorkingDay,
              doer.assignShift,
              true,
            );

            dueDate = new Date(nextShiftStart.getTime() + overflowMs);
          }
        } else {
          dueDate = await addWorkingDaysHoliday(
            parentDue,
            x,
            doer.assignShift._id,
            tmplTask.isDependent,
            {},
            taskDeptContext,
          );

          if (!dueDate) {
            dueDate = parentDue;
          }

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
              {},
              taskDeptContext,
            );

            dueDate = snapToShiftTime(nextWorkingDay, doer.assignShift, false);
          }
        }
      }

      dates = {
        startDate,
        dueDate,
      };
    } else if (!tmplTask.isDependent) {
      dates = await fmsDateCalculator.calculateFmsTaskDates(
        tmplTask.toObject(),
        launchDate,
        parsedEndDate,
        doer?.assignShift?._id,
        prevTasks.map((t) => ({
          taskId: t.taskId,
          plannedDueDate: t.plannedDueDate,
          plannedStartDate: t.plannedStartDate,
        })),
        taskDeptContext,
      );
    } else if (tmplTask.startTimeSetting === "actual-to-planned") {
      dates = {
        startDate: null,
        dueDate: null,
      };
    }

    // Strict boolean checking for decision step
    const isDecisionStep =
      tmplTask.decisionStep === true ||
      tmplTask.decisionStep === "yes" ||
      tmplTask.decisionStep === "true";

    const instanceTaskData = {
      fmsInstanceId: instance._id,
      fmsTaskId: tmplTask._id,

      taskId: tmplTask.taskId,
      description: tmplTask.description,

      departmentOfAssignToUser: tmplTask.departmentOfAssignToUser,

      assignedTo: tmplTask.assignedTo,
      assignedBy: tmplTask.assignedBy,

      frequency: tmplTask.frequency,
      linkedWithForm: Boolean(tmplTask.linkedWithForm),
      xValue: tmplTask.xValue,

      isDependent: tmplTask.isDependent,
      dependentOn: tmplTask.dependentOn,
      startTimeSetting: tmplTask.startTimeSetting,

      taskEndDays: tmplTask.taskEndDays || 0,

      plannedStartDate: dates.startDate,
      plannedDueDate: dates.dueDate,

      status:
        tmplTask.startTimeSetting === "actual-to-planned"
          ? "Upcoming"
          : calculateTaskStatus(dates.startDate, dates.dueDate),

      isVisible: false,
      updatedBy: userId,

      decisionStep: isDecisionStep,
      decisionYesAction: isDecisionStep
        ? tmplTask.decisionYesAction || null
        : null,
      triggerFmsTemplate:
        isDecisionStep && tmplTask.decisionYesAction === "trigger_fms"
          ? tmplTask.triggerFmsTemplate || null
          : null,

      decisionAnswer: null,
      decisionRemark: null,
      decisionSubmissionId: null,
      triggeredInstanceId: null,

      checklist: tmplTask.checklist || [],
      createdForm: tmplTask.createdForm || [],
    };

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
      `✅ ${instanceTask.taskId} -> start=${instanceTask.plannedStartDate} due=${instanceTask.plannedDueDate} [DecisionStep: ${isDecisionStep}]`,
    );
  }

  await generateRecurringFmsTasks(instance._id);

  // Mark FMS Template as Launched
  await FmsTemplate.findByIdAndUpdate(templateId, {
    isLaunched: true,
  });

  await instance.populate(["manager", "srManager", "fmsTemplateId"]);

  res.status(201).json({
    success: true,
    data: instance,
    tasks: instanceTasks.map((t) => ({
      taskId: t.taskId,
      plannedStartDate: t.plannedStartDate,
      plannedDueDate: t.plannedDueDate,
      status: t.status,
      decisionStep: t.decisionStep,
      decisionYesAction: t.decisionYesAction,
      triggerFmsTemplate: t.triggerFmsTemplate,
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

  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  if (req.body.checklist) {
    task.checklist = req.body.checklist;
  }

  if (req.body.formData) {
    task.formData = {
      ...(task.formData || {}),
      ...req.body.formData,
    };
  }

  const checklistComplete = task.checklist?.length
    ? task.checklist.every((item) => item.completed)
    : true;

  const formsComplete = (task.createdForm || []).every((field) => {
    if (!field.isMandatory) return true;

    const value = task.formData?.[field.fieldName];

    if (value === undefined || value === null || value === "") {
      return false;
    }

    return true;
  });

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

  if (req.body.status) {
    task.status = req.body.status;
  }
  if (req.body.assignedTo) {
    task.assignedTo = req.body.assignedTo;
  }
  if (req.body.status === "Not Done") {
    task.status = "Not Done";
    task.notDoneRemark = req.body.notDoneRemark || "";
    task.notDoneBy = req.cookies.userId || req.user?._id;

    const markChildrenNotDone = async (parentTaskId) => {
      const children = await FmsInstanceTask.find({
        fmsInstanceId: instanceId,
        dependentOn: parentTaskId,
      });

      for (const child of children) {
        child.status = "Not Done";
        child.notDoneRemark = task.notDoneRemark;
        child.notDoneBy = req.cookies.userId || req.user?._id;
        child.updatedBy = req.cookies.userId || req.user?._id;

        await child.save();

        await markChildrenNotDone(child.taskId);
      }
    };

    await markChildrenNotDone(task.taskId);
  }
  await task.save();

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

  const task = await FmsInstanceTask.findOne({
    fmsInstanceId: instanceId,
    taskId: taskIdParam,
  });

  if (!task) return next(new AppError("Task not found", 404));

  if (!isFmsTaskFullyComplete(task)) {
    return res.status(400).json({
      error: "Complete checklist and mandatory forms first",
    });
  }

  const completionDate = new Date();
  task.actualCompleteDate = completionDate;
  task.completedAt = completionDate;
  task.status = "Completed";
  task.updatedBy = req.cookies?.userId || req.user?._id || null;
  task.completedBy = req.cookies?.userId || req.user?._id || null;
  await task.save();
  await updateInstanceProgress();

  const children = await FmsInstanceTask.find({
    fmsInstanceId: instanceId,
    startTimeSetting: "actual-to-planned",
    dependentOn: task.taskId,
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

  for (const child of children) {
    try {
      const workShift = await User.findById(child.assignedTo).populate(
        "assignShift",
      );
      const shift = workShift?.assignShift;

      if (!shift) continue;

      const taskDeptContext =
        child.departmentOfAssignToUser ||
        workShift?.department ||
        workShift?._id;

      const parentStart = task.plannedStartDate;
      const parentDue = task.plannedDueDate;
      let startDate;
      let dueDate;

      if (!parentStart || !parentDue) continue;

      const isSameShift = String(shift?._id) === String(parentWorkShift?._id);

      if (!isSameShift) {
        console.log("⚠️ Shift mismatch → using child shift window only");

        const baseDate = new Date(parentStart);

        const start = await nextWorkingShiftDate(
          baseDate,
          shift._id,
          {},
          taskDeptContext,
        );

        startDate = snapToShiftTime(start, shift, true);
        dueDate = snapToShiftTime(start, shift, false);
      } else {
        const x = Number(child.xValue || 0);
        const freq = (child.frequency || "").toLowerCase();

        startDate = new Date(task.actualCompleteDate);
        dueDate = new Date(parentDue);

        if (freq.includes("hour")) {
          let calculatedDue = new Date(parentDue);
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
              {},
              taskDeptContext,
            );

            const nextShiftStart = snapToShiftTime(nextWorkingDay, shift, true);

            dueDate = new Date(nextShiftStart.getTime() + overflowMs);
          }
        } else {
          dueDate = await addWorkingDaysHoliday(
            parentDue,
            x,
            shift._id,
            child.isDependent,
            {},
            taskDeptContext,
          );

          if (!dueDate) {
            dueDate = parentDue;
          }

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
              {},
              taskDeptContext,
            );

            dueDate = snapToShiftTime(nextWorkingDay, shift, false);
          }
        }
      }

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
    const incomingData = req.body;

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

    const createdForm = task.createdForm || [];
    const updatedFormData = { ...(task.formData || {}) };

    for (const field of createdForm) {
      const value = incomingData[field.fieldName];

      if (value !== undefined) {
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
        field.completed = true;
      }
    }

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

    task.formData = updatedFormData;
    task.updatedBy = userId;
    task.markModified("createdForm");
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

  await instance.save();
  await FmsInstanceTask.updateMany(
    {
      fmsInstanceId: instance._id,
    },
    { status: "Onhold" },
  );

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
  await FmsInstanceTask.updateMany(
    {
      fmsInstanceId: instance._id,
    },
    {
      status: "Stopped",
    },
  );

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
    isTerminated,
    role: bodyRole,
  } = req.body;

  const userId = req.cookies?.userId || req.user?._id;

  const roleInput = bodyRole || req.user?.role || req.cookies?.role;
  const rawRole = typeof roleInput === "object" ? roleInput?.name : roleInput;
  const userRole = String(rawRole || "").toLowerCase();

  const query = { isTerminated: false };

  if (userRole === "admin" || userRole === "pc") {
    // Admin / PC sees all
  } else if (userRole === "sr. manager" || userRole === "srmanager") {
    const managerRole = await Role.findOne({ name: "Manager" })
      .select("_id")
      .lean();

    if (managerRole) {
      const managerUsers = await User.find({ role: managerRole._id })
        .select("_id")
        .lean();
      const managerIds = managerUsers.map((u) => u._id);

      query.createdBy = {
        $in: [userId, ...managerIds],
      };
    } else {
      query.createdBy = userId;
    }
  } else {
    query.createdBy = userId;
  }

  if (typeof isTerminated !== "undefined") {
    query.isTerminated =
      isTerminated === true ||
      isTerminated === "true" ||
      isTerminated === 1 ||
      isTerminated === "1";
  }

  if (search) {
    query.$or = [
      { instanceId: { $regex: search, $options: "i" } },
      { instanceName: { $regex: search, $options: "i" } },
    ];
  }

  if (instanceId) {
    query.instanceId = { $regex: instanceId, $options: "i" };
  }

  if (instanceName) {
    query.instanceName = { $regex: instanceName, $options: "i" };
  }

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

  const skip = (Number(page) - 1) * Number(limit);

  const [instances, total] = await Promise.all([
    FmsInstance.find(query)
      .populate(
        "fmsTemplateId manager srManager createdBy",
        "templateName fmsId name email",
      )
      .sort({ startDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    FmsInstance.countDocuments(query),
  ]);

  res.json({
    success: true,
    data: instances,
    pagination: {
      current: Number(page),
      pages: Math.ceil(total / Number(limit)) || 1,
      total,
      limit: Number(limit),
    },
  });
});

//**GET FMS COUNTS FOR DASHBOARD */
export const getFmsInstancesCount = handleAsync(async (req, res) => {
  const matchStage = {
    triggerType: { $ne: "FORM_SUBMISSION" },
  };
  const result = await FmsInstance.aggregate([
    { $match: matchStage },

    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
      },
    },
  ]);

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
    .populate("updatedBy", "name email")
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
      select: "instanceName status progress isTerminated",
    })
    .populate({
      path: "fmsTaskId",
      select: "taskId assignedBy",
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

//**GET FMS TEMPLATE BY FMS INSTANCE TASKS */
export const getAssignedTaskTemplates = handleAsync(async (req, res) => {
  const {
    userId,
    role: rawRole,
    selectedDoer,
    selectedManager,
    selectedSrManager,
  } = req.body;

  const role = rawRole ? rawRole.toLowerCase().replace(/\s+/g, "") : "";

  const fmsAndConditions = [
    { isTerminated: { $ne: true } },
    { status: { $nin: ["Terminated"] } },
  ];

  if (role === "admin" || role === "owner" || role === "pc") {
    if (selectedDoer && selectedDoer !== "all") {
      fmsAndConditions.push({
        assignedTo: new mongoose.Types.ObjectId(selectedDoer),
      });
    }
    if (selectedManager && selectedManager !== "all") {
      const managerObjId = new mongoose.Types.ObjectId(selectedManager);
      fmsAndConditions.push({
        $or: [{ updatedBy: managerObjId }, { assignedTo: managerObjId }],
      });
    }
    if (selectedSrManager && selectedSrManager !== "all") {
      const srManagerObjId = new mongoose.Types.ObjectId(selectedSrManager);
      fmsAndConditions.push({
        $or: [{ updatedBy: srManagerObjId }, { assignedTo: srManagerObjId }],
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

    const allIds = [userId, ...managerIds, ...memberIds].map(
      (id) => new mongoose.Types.ObjectId(id),
    );
    fmsAndConditions.push({ assignedTo: { $in: allIds } });
  } else if (role === "manager") {
    const members = await User.find({ reportingManager: userId })
      .select("_id")
      .lean();
    const memberIds = members.map((m) => m._id);

    const allIds = [userId, ...memberIds].map(
      (id) => new mongoose.Types.ObjectId(id),
    );
    fmsAndConditions.push({ assignedTo: { $in: allIds } });
  } else {
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      fmsAndConditions.push({
        assignedTo: new mongoose.Types.ObjectId(userId),
      });
    }
  }

  const templates = await FmsInstanceTask.aggregate([
    { $match: { $and: fmsAndConditions } },
    {
      $lookup: {
        from: "fmsinstances",
        localField: "fmsInstanceId",
        foreignField: "_id",
        as: "instance",
      },
    },
    { $unwind: "$instance" },
    {
      $lookup: {
        from: "fmstemplates",
        localField: "instance.fmsTemplateId",
        foreignField: "_id",
        as: "template",
      },
    },
    { $unwind: "$template" },
    { $match: { "template.isDeleted": false } },
    {
      $group: {
        _id: "$template._id",
        fmsId: { $first: "$template.fmsId" },
        templateName: { $first: "$template.templateName" },
      },
    },
    { $sort: { templateName: 1 } },
  ]);

  res.status(200).json({
    success: true,
    data: templates,
  });
});
