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
const RECURRING_FREQUENCIES = ["Daily", "Weekly", "Monthly", "Anytime"];
import { isFmsTaskFullyComplete } from "../utils/fmsTaskValidator.js";
import { createLog } from "./logController.js";
import { updateTaskStatuses } from "../cron/taskStatusUpdate.js";
import { updateInstanceProgress } from "../cron/fmsInstanceTaskProgressCron.js";
import Counter from "../models/Counter.js";
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
      : null;

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

  // const instanceCode = `FMS-${new Date().getFullYear()}-${sequence}`;
  const instance = await FmsInstance.create({
    fmsTemplateId: template._id,
    instanceName: `${template.templateName}`,
    startDate: launchDate,
    endDate: endDate ? endDate : instanceEnd,
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

    // ======================================================
    // NO DEPENDENCY
    // ======================================================

    if (!tmplTask.isDependent) {
      dates = await fmsDateCalculator.calculateFmsTaskDates(
        tmplTask.toObject(),
        launchDate,
        instanceEnd,
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
    else if (tmplTask.startTimeSetting === "planned-to-planned") {
      dates = await fmsDateCalculator.calculateFmsTaskDates(
        tmplTask.toObject(),
        launchDate,
        instanceEnd,
        doer.assignShift?._id,
        prevTasks.map((t) => ({
          taskId: t.taskId,
          plannedDueDate: t.plannedDueDate,
          plannedStartDate: t.plannedStartDate,
        })),
      );
    }

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
      tmplTask.isDependent &&
      tmplTask.startTimeSetting === "actual-to-planned"
    ) {
      instanceTaskData.waitingForParent = true;
    }

    const instanceTask = new FmsInstanceTask(instanceTaskData);

    await instanceTask.save();

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

  console.log("COMPLETING:", task.taskId);

  if (!task) return next(new AppError("Task not found", 404));

  // Mark complete
  if (!isFmsTaskFullyComplete(task)) {
    return res
      .status(400)
      .json({ error: "Complete checklist and mandatory forms first" });
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
    waitingForParent: true,
    dependentOn: task.taskId, // ← CHILDREN dependentOn = THIS parent.taskId
  });
  // .populate('assignedTo assignShift');

  console.log(
    `FOUND ${children.length} A-T-P children waiting for ${task.taskId}`,
  );

  for (const child of children) {
    const parentDue = task.plannedDueDate; // parent.plannedDueDate
    const user = await User.findOne({ _id: child.assignedTo }).populate(
      "assignShift",
    );
    const workShift = user.assignShift;
    if (!workShift) continue;

    let childStart = new Date(parentDue); // copy parent due

    // ± x hr/days to parent due → child start
    if (child.frequency.includes("hour")) {
      const isNegative = child.frequency.includes("-");
      const multiplier = isNegative ? -1 : 1;
      const shiftStart = await nextWorkingShiftDate(childStart, workShift._id);
      childStart = new Date(shiftStart);
      childStart.setHours(childStart.getHours() + child.xValue * multiplier);
    } else {
      const isNegative = child.frequency.includes("-");
      const multiplier = isNegative ? -1 : 1;

      // DAYS
      // 1. Get target DAY from parentDue + x days
      const targetDay = await addWorkingDaysHoliday(
        parentDue,
        child.xValue * multiplier,
        workShift._id,
      );

      // 2. SNAP to shift START time (same day)
      childStart = snapToShiftTime(targetDay, workShift, true); // true=START
    }

    // child.due = childStart same day → shift END
    const childDue = snapToShiftTime(childStart, workShift, false); // shift end same day

    // Update
    child.plannedStartDate = childStart;
    child.plannedDueDate = childDue;
    child.actualStartDate = childStart;
    child.waitingForParent = false;
    child.status = calculateTaskStatus(childStart, childDue);
    await child.save();
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
  console.log(instance);
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
  const query = {createdBy: userId };

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
