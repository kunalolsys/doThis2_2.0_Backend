import cron from "node-cron";
import moment from "moment";
import mongoose from "mongoose";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsTask from "../models/FmsTask.js";
import User from "../models/User.js";
import WorkingWeek from "../models/WorkingWeek.js";
import {
  addWorkingDaysHoliday,
  nextWorkingShiftDate,
  snapToShiftTime,
} from "../utils/dateCalculator.js";
import { addDays, format } from "date-fns";
import { sendNotification } from "../services/telegram/services/taskTelegramService.js";

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
  const assignedParentUser = await User.findById(
    parentInstanceTask.assignedTo,
  ).populate("assignShift");
  if (!assignedParentUser) {
    return next(
      new AppError(
        `User with ID ${parentInstanceTask.assignedTo} not found`,
        404,
      ),
    );
  }

  const parentWorkShift = assignedParentUser.assignShift;
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

    const parentStart = parentInstanceTask.plannedStartDate;
    const parentDue = parentInstanceTask.plannedDueDate;
    let startDate;
    let dueDate;
    if (!parentStart || !parentDue) continue;
    const isSameShift =
      String(doer.assignShift?._id) === String(parentWorkShift?._id);
    // =====================================
    // CHILD START = SAME AS PARENT START
    // =====================================
    if (!isSameShift) {
      console.log("⚠️ Shift mismatch → using child shift window only");

      const baseDate = new Date(parentStart);

      const start = await nextWorkingShiftDate(baseDate, doer.assignShift._id);

      startDate = snapToShiftTime(start, doer.assignShift, true);
      dueDate = snapToShiftTime(start, doer.assignShift, false);

      // ❗ DO NOT return
      // just skip dependency math
    } else {
      startDate = new Date(parentStart);

      dueDate = new Date(parentDue);

      const x = Number(childTemplate.xValue || 0);
      const freq = (childTemplate.frequency || "").toLowerCase();

      if (doer?.assignShift) {
        // =====================================
        // HOURS
        // =====================================
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
            );

            const nextShiftStart = snapToShiftTime(
              nextWorkingDay,
              doer.assignShift,
              true,
            );

            dueDate = new Date(nextShiftStart.getTime() + overflowMs);
          }
        }

        // =====================================
        // DAYS
        // =====================================
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

            dueDate = snapToShiftTime(nextWorkingDay, doer.assignShift, false);
          }
        }
      }
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
    sendNotification({
      type: "TASK_ASSIGNED",
      task: childInstanceTask,
      actor: childTemplate.assignedBy,
    });
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
        const assignedByUser = await User.findById(task.assignedBy).select(
          "name email",
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
        sendNotification({
          type: "TASK_ASSIGNED",
          task: parentInstanceTask,
          actor: assignedByUser,
        });
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
