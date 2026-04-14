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
import { format } from "date-fns";

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

export const generateRecurringFmsTasks = async () => {
  console.log("\n🚀 FMS CRON -", new Date().toLocaleString("en-IN"));

  try {
    const instances = await FmsInstance.find({
      status: { $in: ["Ongoing", "Upcoming"] },
      isStopped: false,
    }).populate("fmsTemplateId");

    if (instances.length === 0) {
      console.log("ℹ️ No active FMS instances");
      return;
    }

    const weekDays = await WorkingWeek.findOne({ isDefault: true });
    let createdCount = 0;

    for (const instance of instances) {
      console.log(`\n📂 FMS: ${instance.instanceId}`);

      const tasks = await FmsTask.find({
        fmsTemplateId: instance.fmsTemplateId._id,
        frequency: { $in: ["Daily", "Weekly", "Monthly", "Anytime"] },
      }).lean();

      for (const task of tasks) {
        if (!isTaskDueToday(task, instance, weekDays)) continue;

        // Duplicate prevention
        const todayRange = {
          $gte: moment().startOf("day").toDate(),
          $lte: moment().endOf("day").toDate(),
        };

        if (
          await FmsInstanceTask.findOne({
            fmsInstanceId: instance._id,
            fmsTaskId: task._id,
            createdAt: todayRange,
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
        const instanceTaskId = `${task.taskId}-R${count + 1}`;
        await new FmsInstanceTask({
          fmsInstanceId: instance._id,
          fmsTaskId: task._id,
          taskId: instanceTaskId,
          description: task.description,
          departmentOfAssignToUser: task.departmentOfAssignToUser,
          assignedTo: task.assignedTo,
          frequency: task.frequency,
          plannedStartDate: shiftStart,
          plannedDueDate: shiftEnd,
          status: "Upcoming",
          isVisible: false,
          checklist: task.checklist || [],
          createdForm: task.createdForm || [],
        }).save();

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
  cron.schedule("*/30 * * * * *", generateRecurringFmsTasks, {
    timezone: "Asia/Kolkata",
  });
  console.log("🔄 FMS Cron: Every 30s (TEST)");

  // Production: Daily 01:00
  // cron.schedule("0 1 * * *", generateRecurringFmsTasks, {
  //   timezone: "Asia/Kolkata",
  // });
};

export default startRecurringFmsTaskJob;
