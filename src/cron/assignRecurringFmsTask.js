import cron from "node-cron";
import moment from "moment";
import mongoose from "mongoose";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsTask from "../models/FmsTask.js";
import User from "../models/User.js";
import WorkingWeek from "../models/WorkingWeek.js";
import {
  nextWorkingShiftDate,
  snapToShiftTime,
} from "../utils/dateCalculator.js";
import { addDays, format } from "date-fns";

const isWorkingDay = (today, weekDays) => {
  const dayLower = today.format("dddd").toLowerCase();
  return weekDays?.workingDays?.[dayLower] === true;
};

const isTaskDueToday = (task, instance, weekDays) => {
  const today = moment().startOf("day");

  console.log("\n📅 CHECK:", task.taskId, task.frequency);

  // FMS active check
  const start = moment(instance.startDate).startOf("day");
  if (today.isBefore(start)) return false;

  const end = instance.endDate ? moment(instance.endDate).endOf("day") : null;
  if (end && today.isAfter(end)) return false;

  const todayDay = today.format("dddd").toLowerCase();
  // if (!isWorkingDay(today, weekDays)) {
  //   console.log("⏭️ Non-working day:", todayDay);
  //   return false;
  // }

  let due = false;
  switch (task.frequency) {
    case "Daily":
    case "Anytime":
      due = true;
      break;

    case "Weekly":
      // Every week on same weekday as startDate (adjusted to working)
      const startDay = start.format("dddd").toLowerCase();
      due = todayDay === startDay && isWorkingDay(today, weekDays);
      break;

    case "Monthly":
      // Same date each month (adjusted)
      const startDateNum = start.date();
      const expected = today.clone().date(startDateNum);
      if (!expected.isValid()) expected.date(1); // Fallback

      due = today.isSame(expected, "day") && isWorkingDay(today, weekDays);
      break;
  }

  console.log(due ? "✅ DUE" : "⏭️ SKIP");
  return due;
};
export const generateDependentChildren = async (
  instance,
  parentInstanceTask,
  parentTemplateTask,
) => {
  const children = await FmsTask.find({
    dependentOn: parentTemplateTask.taskId,
    // startTimeSetting: "planned-to-planned",
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

    const parentDate =
      parentInstanceTask.plannedDueDate || parentInstanceTask.plannedStartDate;

    if (!parentDate) continue;

    const freq = childTemplate.frequency.toLowerCase();

    let startDate = new Date(parentDate);

    const x = Number(childTemplate.xValue || 0);

    if (freq.includes("hour")) {
      if (freq.includes("task+x")) {
        startDate = new Date(parentDate.getTime() + x * 60 * 60 * 1000);
      } else {
        startDate = new Date(parentDate.getTime() - x * 60 * 60 * 1000);
      }
    } else {
      if (freq.includes("task+x")) {
        startDate = addDays(parentDate, x);
      } else {
        startDate = addDays(parentDate, -x);
      }
    }

    let dueDate = startDate;

    if (doer?.assignShift) {
      dueDate = snapToShiftTime(startDate, doer.assignShift, false);
    }

    const childInstanceTask = await FmsInstanceTask.create({
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
          : startDate,

      plannedDueDate:
        childTemplate.startTimeSetting === "actual-to-planned" ? null : dueDate,

      status: "Pending",

      checklist: childTemplate.checklist || [],

      createdForm: childTemplate.createdForm || [],
    });

    console.log(`✅ Generated child ${childInstanceTask.taskId}`);

    // recursive support (child -> grandchild)
    await generateDependentChildren(instance, childInstanceTask, childTemplate);
  }
};
export const generateRecurringFmsTasks = async (instanceId = null) => {
  console.log("\n🚀 FMS CRON -", new Date().toLocaleString("en-IN"));

  try {
    // const instances = await FmsInstance.find({
    //   status: { $nin: ["Onhold", "Stopped", "Completed", "Cancelled"] },
    //   isStopped: false,
    // }).populate("fmsTemplateId");

    let instances;

    if (instanceId) {
      instances = await FmsInstance.find({
        _id: instanceId,
      }).populate("fmsTemplateId");
    } else {
      instances = await FmsInstance.find({
        status: { $nin: ["Onhold", "Stopped", "Completed", "Cancelled"] },
        isStopped: false,
      }).populate("fmsTemplateId");
    }
    if (instances.length === 0) {
      console.log("ℹ️ No active FMS instances");
      return;
    }

    const weekDays = await WorkingWeek.findOne({ isDefault: true });
    let createdCount = 0;

    for (const instance of instances) {
      if (
        instance.status === "Onhold" ||
        instance.status === "Stopped" ||
        instance.isStopped
      ) {
        console.log(`⛔ Skipping ${instance.instanceId} (${instance.status})`);
        continue;
      }
      console.log(`\n📂 FMS: ${instance.instanceId}`);

      const tasks = await FmsTask.find({
        fmsTemplateId: instance.fmsTemplateId._id,
        frequency: { $in: ["Daily", "Weekly", "Monthly"] },
      }).lean();

      for (const task of tasks) {
        if (!isTaskDueToday(task, instance, weekDays)) continue;

        // Duplicate prevention
        const todayRange = {
          $gte: moment().startOf("day").toDate(),
          $lte: moment().endOf("day").toDate(),
        };
        const recurrenceKey = moment().format("YYYY-MM-DD");

        if (
          await FmsInstanceTask.findOne({
            fmsInstanceId: instance._id,
            fmsTaskId: task._id,
            // createdAt: todayRange,
            recurrenceKey,
          })
        ) {
          console.log(`⚠️ Duplicate: ${task.taskId}`);
          continue;
        }

        // Shift timing
        const user = await User.findById(task.assignedTo).populate(
          "assignShift",
        );
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
        const parentInstanceTask = await new FmsInstanceTask({
          fmsInstanceId: instance._id,
          fmsTaskId: task._id,
          formId: instance.formId || null,
          submissionId: instance.submissionId || null,
          submissionData: instance.runtimeContext || {},
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
        }).save();
        await generateDependentChildren(instance, parentInstanceTask, task);
        createdCount++;
        console.log(
          `✅ ${task.taskId} | ${format(shiftStart, "HH:mm dd-MM")}→${format(shiftEnd, "HH:mm")}`,
        );
      }
    }

    console.log(`\n📊 TOTAL: ${createdCount} tasks created`);
  } catch (error) {
    console.error("💥 ERROR:", error);
  }
};

const startRecurringFmsTaskJob = () => {
  // // Test every 30s
  // cron.schedule("*/3 * * * * *", generateRecurringFmsTasks, {
  //   timezone: "Asia/Kolkata",
  // });
  console.log("🔄 FMS Cron: Every 30s (TEST)");

  //This runs every day at 9:00 AM IST.
  cron.schedule(
    "0 9 * * *",
    () => {
      generateRecurringFmsTasks(null);
    },
    {
      timezone: "Asia/Kolkata",
    },
  );
};

export default startRecurringFmsTaskJob;
