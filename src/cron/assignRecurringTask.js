import cron from "node-cron";
import moment from "moment-timezone"; // Use moment-timezone
import { RecurringTask, DelegationTask } from "../models/Task.js";
import User from "../models/User.js";
import {
  nextWorkingShiftDate,
  addWorkingDays,
  isWorkingDay,
  snapToShiftTime,
  isHoliday,
} from "../utils/dateCalculator.js";
import { format } from "date-fns";
import { sendNotification } from "../services/telegram/services/taskTelegramService.js";
import { taskAssignedTemplate } from "../services/templates/taskAssignedTemp.js";
import sendEmail from "../services/emailService.js";

// Helper: Check if today matches the frequency criteria
const isTaskDueToday = (task) => {
  // Always evaluate today in Asia/Kolkata timezone
  const today = moment().tz("Asia/Kolkata").startOf("day");
  const start = moment(task.startDate).tz("Asia/Kolkata").startOf("day");

  if (today.isBefore(start)) return false;
  if (
    task.endDate &&
    today.isAfter(moment(task.endDate).tz("Asia/Kolkata").endOf("day"))
  ) {
    return false;
  }

  switch (task.frequency) {
    case "Daily":
      return true;

    case "Weekly":
      const currentDayName = today.format("dddd").toLowerCase();
      return task.weekDays.includes(currentDayName);

    case "Bi-weekly": {
      if (!task.weekStartDay) return false;

      const days = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ];

      const startDay = days.indexOf(task.weekStartDay.toLowerCase());
      const offset = Number(task.repeatAfter || 0);

      if (offset < 0 || offset > 6) return false;

      const secondDay = (startDay + offset) % 7;
      const todayDay = today.day();

      return todayDay === startDay || todayDay === secondDay;
    }

    case "Fortnightly":
      const daysDiff = today.diff(start, "days");
      return daysDiff % 14 === 0;

    case "Monthly":
      return today.date() === start.date();

    case "Quarterly":
      const qDiff = today.diff(start, "months");
      return qDiff % 3 === 0 && today.date() === start.date();

    case "Half Yearly":
      const hDiff = today.diff(start, "months");
      return hDiff % 6 === 0 && today.date() === start.date();

    case "Yearly":
      return today.month() === start.month() && today.date() === start.date();

    default:
      return false;
  }
};

// Main Job - WORKSHIFT AWARE
export const generateRecurringTasks = async (recurringTaskId = null) => {
  console.log("recurringTaskId", recurringTaskId);
  console.log("⏳ Cron: WorkShift-Aware Recurring Tasks...");

  try {
    // 1. Get exact current time in IST
    const nowIST = moment().tz("Asia/Kolkata");
    const todayStr = nowIST.format("YYYY-MM-DD");

    const query = { isDeleted: { $ne: true } };
    if (recurringTaskId) {
      query._id = recurringTaskId;
    }

    const recurringTasks = await RecurringTask.find(query);
    let createdCount = 0;

    for (const task of recurringTasks) {
      if (!isTaskDueToday(task)) continue;

      // CHECK USER WORKSHIFT FOR TODAY
      const assignedUser = await User.findById(task.assignedTo).populate(
        "assignShift",
      );
      if (!assignedUser?.assignShift) {
        console.log(`⚠️ Skipping ${task.TaskId}: No workshift`);
        continue;
      }

      const workShift = assignedUser.assignShift;

      // Generate unique instance key
      const instanceKey = `${task._id}_${todayStr}`;

      // Prevent duplicate
      const alreadyExists = await DelegationTask.findOne({ instanceKey });
      if (alreadyExists) {
        console.log(
          `⏭️ Skip duplicate/deleted instance: ${task.TaskId} [Key: ${instanceKey}]`,
        );
        continue;
      }

      // 🔥 FIX: Pass today's 00:00:00 IST date to date calculator rather than exact execution time (e.g. 01:00 AM)
      const baseTodayDate = nowIST.clone().startOf("day").toDate();

      let todayShiftStart = await nextWorkingShiftDate(
        baseTodayDate,
        workShift._id,
      );

      // 🔥 FORCE FIX: If shift calculation pushes it to previous day due to UTC shift offsets, align back to todayStr
      const calculatedStartStr = moment(todayShiftStart)
        .tz("Asia/Kolkata")
        .format("YYYY-MM-DD");
      if (calculatedStartStr !== todayStr) {
        // Parse time component from calculated shift start and force target date to todayStr
        const timePart = moment(todayShiftStart)
          .tz("Asia/Kolkata")
          .format("HH:mm:ss");
        todayShiftStart = moment
          .tz(`${todayStr} ${timePart}`, "YYYY-MM-DD HH:mm:ss", "Asia/Kolkata")
          .toDate();
      }

      if (task.endDate) {
        const endDate = moment(task.endDate)
          .tz("Asia/Kolkata")
          .endOf("day")
          .toDate();
        if (todayShiftStart > endDate) {
          console.log(`⏭️ Skip ${task.TaskId}: shifted beyond endDate`);
          continue;
        }
      }

      const isTodayHoliday = await isHoliday(todayShiftStart);
      if (isTodayHoliday || !isWorkingDay(todayShiftStart, workShift)) {
        console.log(
          `⏭️ Skip ${task.TaskId}: Non-working day/holiday (${format(todayShiftStart, "dd-MM-yyyy")})`,
        );
        continue;
      }

      let shiftDueEnd;

      if (task.taskEndDays) {
        shiftDueEnd = await addWorkingDays(
          todayShiftStart,
          task.taskEndDays,
          workShift._id,
        );
      } else if (task.endDate) {
        shiftDueEnd = new Date(todayShiftStart);
        const recurringEnd = new Date(task.endDate);

        shiftDueEnd.setHours(
          recurringEnd.getHours(),
          recurringEnd.getMinutes(),
          recurringEnd.getSeconds(),
          recurringEnd.getMilliseconds(),
        );
      } else {
        shiftDueEnd = snapToShiftTime(todayShiftStart, workShift, false);
      }

      const assignedByUser = await User.findById(task.assignedBy).select(
        "name email",
      );
      const assignedToUser = await User.findById(task.assignedTo).select(
        "name email",
      );

      // CREATE DELEGATION INSTANCE
      const newDelegation = new DelegationTask({
        title: task.title,
        description: task.description,
        assignedTo: task.assignedTo,
        assignedBy: task.assignedBy,
        departmentOfAssignToUser: task.departmentOfAssignToUser,
        startDate: todayShiftStart,
        dueDate: shiftDueEnd,
        recurrenceTaskId: task._id,
        recurringRefId: task.TaskId,
        instanceKey: instanceKey,
        frequency: task.frequency,
        checklist:
          task.checklist?.map((item) => ({ ...item, isCompleted: false })) ||
          [],
        status: "Pending",
        isVisible: false,
        attachmentFile: task.attachmentFile || [],
        currentHolder: task.assignedTo,
        distributionStatus: "Awaiting Distribution",
        delegationFlowEnabled: true,
        isDeleted: false,
      });

      await newDelegation.save();
      createdCount++;

      sendNotification({
        type: "TASK_ASSIGNED",
        task: newDelegation,
        actor: assignedByUser,
      });

      const emailTemplate = taskAssignedTemplate({
        userName: assignedToUser?.name,
        taskId: newDelegation.TaskId,
        title: newDelegation.title,
        description: newDelegation.description,
        dueDate: newDelegation.dueDate
          ? new Date(newDelegation.dueDate).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })
          : "N/A",
        assignedBy: assignedByUser?.name,
      });

      if (assignedToUser?.email) {
        sendEmail({
          to: assignedToUser.email,
          subject: emailTemplate.subject,
          html: emailTemplate.html,
        });
      }

      console.log(
        `✅ Generated ${newDelegation.TaskId} (${task.frequency}) → ${format(todayShiftStart, "yyyy-MM-dd HH:mm")} to ${format(shiftDueEnd, "yyyy-MM-dd HH:mm")}`,
      );
    }

    console.log(
      `✅ Cron Complete: ${createdCount} workshift-aware tasks generated`,
    );
  } catch (error) {
    console.error("❌ Cron Error:", error);
  }
};

const startCronJobs = () => {
  // Daily at 00:01 AM IST
  cron.schedule(
    "0 7 * * *",
    () => {
      generateRecurringTasks(null);
    },
    {
      timezone: "Asia/Kolkata",
    },
  );
  console.log("🔄 Recurring Cron scheduled: Daily 00:01 IST (WorkShift Aware)");
};

export default startCronJobs;
