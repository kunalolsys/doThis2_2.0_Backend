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

    case "Weekly": {
      const currentDayName = today.format("dddd").toLowerCase();
      return (
        Array.isArray(task.weekDays) && task.weekDays.includes(currentDayName)
      );
    }

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

    case "Fortnightly": {
      const daysDiff = today.diff(start, "days");
      return daysDiff % 14 === 0;
    }

    case "Monthly":
      return today.date() === start.date();

    case "Quarterly": {
      const qDiff = today.diff(start, "months");
      return qDiff % 3 === 0 && today.date() === start.date();
    }

    case "Half Yearly": {
      const hDiff = today.diff(start, "months");
      return hDiff % 6 === 0 && today.date() === start.date();
    }

    case "Yearly":
      return today.month() === start.month() && today.date() === start.date();

    default:
      return false;
  }
};

// Main Job - WORKSHIFT & DEPARTMENT AWARE
export const generateRecurringTasks = async (recurringTaskId = null) => {
  console.log("recurringTaskId:", recurringTaskId);
  console.log("⏳ Cron: WorkShift-Aware Recurring Tasks Started...");

  try {
    // 1. Get exact current time in IST
    const nowIST = moment().tz("Asia/Kolkata");
    const todayStr = nowIST.format("YYYY-MM-DD");

    const query = { isDeleted: { $ne: true } };
    if (recurringTaskId) {
      query._id = recurringTaskId;
    }

    const recurringTasks = await RecurringTask.find(query).lean();
    let createdCount = 0;

    for (const task of recurringTasks) {
      // 🔒 ISOLATION: Har task ke liye alag try...catch lagaya hai
      // taaki ek task ke fail hone se baaki ke tasks na ruken.
      try {
        if (!isTaskDueToday(task)) continue;

        if (!task.assignedTo) {
          console.log(`⚠️ Skipping ${task.TaskId}: No assignedTo user ID`);
          continue;
        }

        // CHECK USER WORKSHIFT FOR TODAY
        const assignedUser = await User.findById(task.assignedTo)
          .populate("assignShift")
          .lean();

        if (!assignedUser?.assignShift) {
          console.log(
            `⚠️ Skipping ${task.TaskId}: No workshift for user ${task.assignedTo}`,
          );
          continue;
        }

        const workShift = assignedUser.assignShift;

        // Generate unique instance key
        const instanceKey = `${task._id}_${todayStr}`;

        // Prevent duplicate
        const alreadyExists = await DelegationTask.findOne({
          instanceKey,
        }).lean();
        if (alreadyExists) {
          console.log(
            `⏭️ Skip duplicate/deleted instance: ${task.TaskId} [Key: ${instanceKey}]`,
          );
          continue;
        }

        const baseTodayDate = nowIST.clone().startOf("day").toDate();

        // 🔥 TARGET DEPT ID RESOLUTION
        const taskDeptId = task.departmentOfAssignToUser || task.assignedTo;

        // Pass department ID so department resolution works
        let todayShiftStart = await nextWorkingShiftDate(
          baseTodayDate,
          workShift._id,
          {},
          taskDeptId,
        );

        // FORCE FIX: Align back to todayStr
        const calculatedStartStr = moment(todayShiftStart)
          .tz("Asia/Kolkata")
          .format("YYYY-MM-DD");

        if (calculatedStartStr !== todayStr) {
          const timePart = moment(todayShiftStart)
            .tz("Asia/Kolkata")
            .format("HH:mm:ss");
          todayShiftStart = moment
            .tz(
              `${todayStr} ${timePart}`,
              "YYYY-MM-DD HH:mm:ss",
              "Asia/Kolkata",
            )
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

        // Pass department context and await isWorkingDay
        const isTodayHoliday = await isHoliday(todayShiftStart, taskDeptId);
        const isTodayWorking = await isWorkingDay(
          todayShiftStart,
          workShift,
          taskDeptId,
        );

        if (isTodayHoliday || !isTodayWorking) {
          console.log(
            `⏭️ Skip ${task.TaskId}: Non-working day/holiday (${format(
              todayShiftStart,
              "dd-MM-yyyy",
            )})`,
          );
          continue;
        }

        let shiftDueEnd;

        if (task.taskEndDays) {
          // Pass department context for department working schedule and holiday checks
          shiftDueEnd = await addWorkingDays(
            todayShiftStart,
            task.taskEndDays,
            workShift._id,
            {},
            taskDeptId,
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

        const assignedByUser = await User.findById(task.assignedBy)
          .select("name email")
          .lean();
        const assignedToUser = await User.findById(task.assignedTo)
          .select("name email")
          .lean();

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

        // Non-blocking Async Notifications
        try {
          sendNotification({
            type: "TASK_ASSIGNED",
            task: newDelegation,
            actor: assignedByUser,
          }).catch((e) =>
            console.error(
              `Telegram Notif Error for ${newDelegation.TaskId}:`,
              e.message,
            ),
          );

          if (assignedToUser?.email) {
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

            sendEmail({
              to: assignedToUser.email,
              subject: emailTemplate.subject,
              html: emailTemplate.html,
            }).catch((e) =>
              console.error(
                `Email Error for ${newDelegation.TaskId}:`,
                e.message,
              ),
            );
          }
        } catch (notifErr) {
          console.error("Notification trigger error:", notifErr);
        }

        console.log(
          `✅ Generated ${newDelegation.TaskId} (${task.frequency}) → ${format(
            todayShiftStart,
            "yyyy-MM-dd HH:mm",
          )} to ${format(shiftDueEnd, "yyyy-MM-dd HH:mm")}`,
        );
      } catch (singleTaskError) {
        // Kisi single task me error aane par agla task process hoga
        console.error(
          `❌ Error processing task ${task?.TaskId || task?._id}:`,
          singleTaskError,
        );
      }
    }

    console.log(
      `✅ Cron Complete: ${createdCount} workshift-aware tasks generated`,
    );
  } catch (error) {
    console.error("❌ Fatal Cron Error:", error);
  }
};

const startCronJobs = () => {
  // Subah 09:00 AM IST Backup / Sync Schedule (Optional)
  cron.schedule(
    "0 9 * * *",
    () => {
      console.log("⏰ Running 09:00 AM Task Generation Sync...");
      generateRecurringTasks(null);
    },
    {
      timezone: "Asia/Kolkata",
    },
  );

  console.log("🔄 Recurring Cron scheduled: Daily 09:00 AM IST");
};

export default startCronJobs;
