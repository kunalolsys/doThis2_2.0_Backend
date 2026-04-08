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

//**TO LAUNCH FMS */
export const launchFmsInstance = handleAsync(async (req, res, next) => {
  const { templateId } = req.params;
  const { launchDate: launchDateStr } = req.body;

  const userId = req.cookies.userId;
  const template = await FmsTemplate.findById(templateId).populate([
    "manager",
    "srManager",
  ]);
  if (!template) return next(new AppError("Template not found", 404));
  // 🔒 CHECK BEFORE CREATING INSTANCE
  const existingInstance = await FmsInstance.findOne({
    fmsTemplateId: templateId,
    status: { $in: ["Upcoming", "Ongoing"] },
  });

  if (existingInstance) {
    return next(
      new AppError(
        `FMS already launched (Instance: ${existingInstance.instanceName})`,
        400,
      ),
    );
  }
  const launchDate = new Date(launchDateStr || Date.now());
  const instanceEnd =
    template.fmsDuration === "Fixed Period" ? template.endDate : null;
  // console.log(template)
  // Create instance
  const instance = await FmsInstance.create({
    fmsTemplateId: template._id,
    instanceName: `${template.templateName} (${launchDate.toLocaleDateString()})`,
    startDate: launchDate,
    endDate: instanceEnd,
    manager: template.manager._id,
    srManager: template.srManager?._id || null,
    createdBy: userId,
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

    const dates = await fmsDateCalculator.calculateFmsTaskDates(
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

    const instanceTaskData = {
      fmsInstanceId: instance._id,
      fmsTaskId: tmplTask._id,
      taskId: tmplTask.taskId,
      description: tmplTask.description,
      departmentOfAssignToUser: tmplTask.departmentOfAssignToUser,
      assignedTo: tmplTask.assignedTo,
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
      status: calculateTaskStatus(dates.startDate, dates.dueDate),
      isVisible: false, // Cron taskVisibilityCron.js handles
      updatedBy: userId,
      checklist: tmplTask.checklist || [],
      createdForm: tmplTask.createdForm || [],
    };
    if (tmplTask.startTimeSetting === "actual-to-planned") {
      instanceTaskData.waitingForParent = true;
    }
    const instanceTask = new FmsInstanceTask(instanceTaskData);
    await instanceTask.save();
    instanceTasks.push(instanceTask);

    console.log(
      `✅ ${instanceTask.taskId} → start=${dates.startDate?.toISOString()} due=${dates.dueDate?.toISOString()}`,
    );
  }
  await generateRecurringFmsTasks();

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
  task.updatedBy = req.cookies.userId;
  await task.save();

  // 🔥 FIND CHILDREN (reverse: who depends ON this parent)
  const children = await FmsInstanceTask.find({
    // fmsInstanceId: instanceId,
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

//**STOP FMS INSTANCE */
export const stopFmsInstance = handleAsync(async (req, res) => {
  const instance = await FmsInstance.findById(req.params.id);
  instance.status = "Stopped";
  instance.isStopped = true;
  instance.history.push({
    event: "stopped",
    byUser: req.cookies.userId,
    reason: req.body.reason,
  });

  // Optional: cancel pending tasks
  await FmsInstanceTask.updateMany(
    {
      fmsInstanceId: instance._id,
      // status: { $in: ['Upcoming', 'Pending'] }
    },
    { status: "Cancelled", isVisible: false },
  );

  await instance.save();
  res.json({ success: true });
});

//**GET LAUNCHED FMS */
export const getFmsInstances = handleAsync(async (req, res) => {
  const instances = await FmsInstance.find()
    .populate(
      "fmsTemplateId manager srManager createdBy",
      "templateName fmsId name",
    )
    .sort({ startDate: -1 });
  res.json({ success: true, data: instances });
});

//**GET LAUNCHED FMS BY ID */
export const getFmsInstanceById = handleAsync(async (req, res, next) => {
  const instance = await FmsInstance.findById(req.params.id)
    .populate({
      path: "tasks",
      populate: ["assignedTo", "departmentOfAssignToUser", "fmsTaskId"],
    })
    .populate("manager srManager fmsTemplateId createdBy");
  if (!instance) return next(new AppError("Instance not found", 404));
  res.json({ success: true, data: instance });
});

//**GET TASKS OF LAUNCHED FMS */
export const getInstanceTasks = handleAsync(async (req, res) => {
  const tasks = await FmsInstanceTask.find({ fmsInstanceId: req.params.id })
    .populate(
      "fmsInstanceId fmsTaskId assignedTo departmentOfAssignToUser updatedBy",
    )
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
