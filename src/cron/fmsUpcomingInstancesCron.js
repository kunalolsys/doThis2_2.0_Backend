import cron from "node-cron";
import moment from "moment";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsTask from "../models/FmsTask.js";
import User from "../models/User.js";
import WorkingWeek from "../models/WorkingWeek.js";
import {
  nextWorkingShiftDate,
  snapToShiftTime,
} from "../utils/dateCalculator.js";

const isWithinInstanceWindow = (instance, todayMoment) => {
  const start = moment(instance.startDate).startOf("day");
  if (todayMoment.isBefore(start)) return false;

  if (instance.fmsDuration === "Timeless") return true;

  if (instance.endDate) {
    const end = moment(instance.endDate).endOf("day");
    return !todayMoment.isAfter(end);
  }

  // Fixed Period but no endDate -> safest: don't generate
  return false;
};

const isTaskDueForTodayByInstanceMode = (
  task,
  instance,
  weekDays,
  todayMoment,
) => {
  // If instance is Timeless, requirement says: generate every day.
  // We'll implement that for template tasks which are eligible for daily generation.
  // (Anytime and Daily -> every day; Weekly/Monthly -> only by their own logic)
  if (instance.fmsDuration === "Timeless") {
    if (task.frequency === "Anytime" || task.frequency === "Daily") return true;
  }

  const todayDayName = todayMoment.format("dddd").toLowerCase();

  // Keep working-day logic consistent with existing cron
  const isWorkingDay = weekDays?.workingDays?.[todayDayName] === true;

  switch (task.frequency) {
    case "Daily":
      return true;

    case "Anytime":
      return true;

    case "Weekly": {
      const start = moment(instance.startDate).startOf("day");
      const startDay = start.format("dddd").toLowerCase();
      return todayDayName === startDay && isWorkingDay;
    }

    case "Monthly": {
      const start = moment(instance.startDate).startOf("day");
      const expected = todayMoment.clone().date(start.date());
      return todayMoment.isSame(expected, "day") && isWorkingDay;
    }

    default:
      return false;
  }
};

const generateDependentChildren = async (
  instance,
  parentInstanceTask,
  parentTemplateTask,
) => {
  const children = await FmsTask.find({
    dependentOn: parentTemplateTask.taskId,
    isDependent: true,
  });

  for (const childTemplate of children) {
    const alreadyExists = await FmsInstanceTask.findOne({
      fmsInstanceId: instance._id,
      fmsTaskId: childTemplate._id,
      dependentOn: parentInstanceTask.taskId,
      recurrenceKey: parentInstanceTask.recurrenceKey,
    });
    if (alreadyExists) continue;

    const doer = await User.findById(childTemplate.assignedTo).populate(
      "assignShift",
    );
    if (!doer?.assignShift) continue;

    const parentDate =
      parentInstanceTask.plannedDueDate || parentInstanceTask.plannedStartDate;
    if (!parentDate) continue;

    // For this cron we schedule dependent children at the same shift window end.
    // (If you need more complex D+X/hour offsets, we can refactor to use fmsDateCalculator)
    const shiftStart = await nextWorkingShiftDate(
      parentDate,
      doer.assignShift._id,
    );
    const shiftEnd = snapToShiftTime(shiftStart, doer.assignShift, false);

    await FmsInstanceTask.create({
      fmsInstanceId: instance._id,
      fmsTaskId: childTemplate._id,

      taskId: childTemplate.taskId,
      description: childTemplate.description,
      departmentOfAssignToUser: childTemplate.departmentOfAssignToUser,
      assignedTo: childTemplate.assignedTo,
      assignedBy: childTemplate.assignedBy,

      frequency: childTemplate.frequency,
      xValue: childTemplate.xValue,
      isDependent: true,
      dependentOn: parentInstanceTask.taskId,

      startTimeSetting: childTemplate.startTimeSetting,
      plannedStartDate:
        childTemplate.startTimeSetting === "actual-to-planned"
          ? null
          : shiftStart,
      plannedDueDate:
        childTemplate.startTimeSetting === "actual-to-planned"
          ? null
          : shiftEnd,

      status: "Pending",
      isVisible: false,
      checklist: childTemplate.checklist || [],
      createdForm: childTemplate.createdForm || [],

      recurrenceKey: parentInstanceTask.recurrenceKey,
      triggerKey: `RECURRENCE:${instance._id}:${childTemplate._id}:${parentInstanceTask.recurrenceKey}`,
    });

    await generateDependentChildren(
      instance,
      { ...parentInstanceTask },
      childTemplate,
    );
  }
};

export const generateUpcomingFmsInstanceTasks = async () => {
  console.log(
    "\n🚀 [FMS UPCOMING INSTANCES CRON] -",
    new Date().toLocaleString("en-IN"),
  );

  const today = moment().startOf("day");
// const today = moment("2026-06-12").startOf("day");
  const weekDays = await WorkingWeek.findOne({ isDefault: true });

  const instances = await FmsInstance.find({
    status: {
      $in: ["Upcoming", "Ongoing", "InProcess", "InProcess", "Upcoming"],
    },
    isStopped: false,
    // also exclude stopped/onhold
    // (we keep it broad and filter below)
  }).populate("fmsTemplateId");

  let createdCount = 0;

  for (const instance of instances) {
    if (
      instance.status === "Onhold" ||
      instance.status === "Stopped" ||
      instance.isStopped
    ) {
      continue;
    }

    if (!isWithinInstanceWindow(instance, today)) continue;

    const tasks = await FmsTask.find({
      fmsTemplateId: instance.fmsTemplateId._id,
    }).lean();

    for (const task of tasks) {
      const due = isTaskDueForTodayByInstanceMode(
        task,
        instance,
        weekDays,
        today,
      );
      if (!due) continue;

      const recurrenceKey = today.format("YYYY-MM-DD");

      const already = await FmsInstanceTask.findOne({
        fmsInstanceId: instance._id,
        fmsTaskId: task._id,
        recurrenceKey,
      });
      if (already) continue;

      const user = await User.findById(task.assignedTo).populate("assignShift");
      if (!user?.assignShift) continue;

      const shiftStart = await nextWorkingShiftDate(
        new Date(),
        user.assignShift._id,
      );
      const shiftEnd = snapToShiftTime(shiftStart, user.assignShift, false);

      const count = await FmsInstanceTask.countDocuments({
        fmsInstanceId: instance._id,
        fmsTaskId: task._id,
      });

      const instanceTaskId = `${instance.instanceId}-${task.taskId}-R${count + 1}`;

      const parentInstanceTask = await FmsInstanceTask.create({
        fmsInstanceId: instance._id,
        fmsTaskId: task._id,

        taskId: instanceTaskId,
        description: task.description,
        departmentOfAssignToUser: task.departmentOfAssignToUser,
        assignedTo: task.assignedTo,
        assignedBy: task.assignedBy,

        frequency: task.frequency,
        plannedStartDate: shiftStart,
        plannedDueDate: shiftEnd,

        status: "Upcoming",
        isVisible: false,

        checklist: task.checklist || [],
        createdForm: task.createdForm || [],

        recurrenceKey,
        triggerKey: `RECURRENCE:${instance._id}:${task._id}:${recurrenceKey}`,
      });

      createdCount++;

      await generateDependentChildren(instance, parentInstanceTask, task);
    }
  }

  console.log(
    `📊 [FMS UPCOMING INSTANCES CRON] Total created: ${createdCount}`,
  );
};

const startFmsUpcomingInstancesCron = () => {
  cron.schedule(
    "*/5 * * * * *",
    () => {
      generateUpcomingFmsInstanceTasks();
    },
    { timezone: "Asia/Kolkata" },
  );

  console.log("🔄 FMS Upcoming Instances Cron scheduled: 9:00 AM IST");
};

export default startFmsUpcomingInstancesCron;
