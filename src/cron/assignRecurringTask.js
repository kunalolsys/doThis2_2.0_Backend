import cron from "node-cron";
import moment from "moment";
import { RecurringTask, DelegationTask, Task } from "../models/Task.js";
import User from "../models/User.js";
import {
  nextWorkingShiftDate,
  addWorkingDays,
  isWorkingDay,
  snapToShiftTime,
  isHoliday
} from "../utils/dateCalculator.js";
import { format } from "date-fns";

// Helper: Check if today matches the frequency criteria
const isTaskDueToday = (task) => {
  const today = moment().utc().startOf("day");
  const start = moment(task.startDate).utc().startOf("day");

  // 1. Basic Date Validation
  if (today.isBefore(start)) return false; // Hasn't started yet
  if (task.endDate && today.isAfter(moment(task.endDate).utc().endOf("day")))
    return false; // Expired

  // 2. Frequency Logic (unchanged)
  switch (task.frequency) {
    case "Daily":
      return true;

    case "Weekly":
      const currentDayName = today.format("dddd").toLowerCase();
      return task.weekDays.includes(currentDayName);

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

// 🔥 Main Job - WORKSHIFT AWARE
const generateRecurringTasks = async () => {
  console.log("⏳ Cron: WorkShift-Aware Recurring Tasks...");

  try {
    const now = new Date();
    const recurringTasks = await RecurringTask.find({
      startDate: { $lte: now },
      $or: [
        { endDate: { $exists: false } },
        { endDate: null },
        { endDate: { $gte: now } },
      ],
    });

    let createdCount = 0;

    for (const task of recurringTasks) {
      if (!isTaskDueToday(task)) continue;

      // 🔥 CHECK USER WORKSHIFT FOR TODAY
      const assignedUser = await User.findById(task.assignedTo).populate('assignShift');
      if (!assignedUser?.assignShift) {
        console.log(`⚠️ Skipping ${task.TaskId}: No workshift`);
        continue;
      }

      const workShift = assignedUser.assignShift;
      
      // 🔥 1. Prevent duplicate (today's instance)
      const startOfDay = moment().utc().startOf("day").toDate();
      const endOfDay = moment().utc().endOf("day").toDate();

      const alreadyExists = await DelegationTask.findOne({
        recurrenceTaskId: task._id,
        createdAt: { $gte: startOfDay, $lte: endOfDay },
      });

      if (alreadyExists) {
        console.log(`⏭️ Skip duplicate: ${task.TaskId}`);
        continue;
      }

      // 🔥 VALIDATE: Working day + not holiday (BEFORE create)
      const todayShiftStart = await nextWorkingShiftDate(now, workShift._id);
      const isTodayHoliday = await isHoliday(todayShiftStart);
      if (isTodayHoliday || !isWorkingDay(todayShiftStart, workShift)) {
        console.log(`⏭️ Skip ${task.TaskId}: Non-working day/holiday (${format(todayShiftStart, 'dd-MM-yyyy')})`);
        continue;
      }
      
      // Today + taskEndDays working days
      const shiftDueEnd = task.taskEndDays 
        ? await addWorkingDays(todayShiftStart, task.taskEndDays, workShift._id)
        : snapToShiftTime(todayShiftStart, workShift, false); // End of shift

      // 🔥 3. CREATE DELEGATION INSTANCE
      const newDelegation = new DelegationTask({
        title: task.title,
        description: task.description,
        assignedTo: task.assignedTo,
        assignedBy: task.assignedBy,
        departmentOfAssignToUser: task.departmentOfAssignToUser,
        startDate: todayShiftStart,
        dueDate: shiftDueEnd,
        recurrenceTaskId: task._id,
        checklist: task.checklist?.map(item => ({ ...item, isCompleted: false })) || [],
        status: 'Pending',
        isVisible: false, // 🔥 Cron visibility system
        attachmentFile: task.attachmentFile || [],
      });

      await newDelegation.save();
      createdCount++;
      
      console.log(`✅ Generated ${newDelegation.TaskId} (${task.frequency}) → ${format(todayShiftStart, 'HH:mm')} to ${format(shiftDueEnd, 'HH:mm')}`);
    }

    console.log(`✅ Cron Complete: ${createdCount} workshift-aware tasks generated`);
  } catch (error) {
    console.error("❌ Cron Error:", error);
  }
};

// Schedule: Daily at shift start time? Or keep 00:01 for batching
const startCronJobs = () => {
  cron.schedule("1 0 * * *", generateRecurringTasks, {
  // cron.schedule("*/5 * * * * *", generateRecurringTasks, {
    timezone: "Asia/Kolkata",
  });
  console.log("🔄 Recurring Cron scheduled: Daily 00:01 IST (WorkShift Aware)");
};

export default startCronJobs;

