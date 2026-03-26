import cron from "node-cron";
import moment from "moment";
import { RecurringTask, DelegationTask } from "../models/Task.js";

// Helper: Check if today matches the frequency criteria
const isTaskDueToday = (task) => {
  const today = moment().utc().startOf("day");
  const start = moment(task.startDate).utc().startOf("day");

  // 1. Basic Date Validation
  if (today.isBefore(start)) return false; // Hasn't started yet
  if (task.endDate && today.isAfter(moment(task.endDate).utc().endOf("day")))
    return false; // Expired

  // 2. Frequency Logic
  switch (task.frequency) {
    case "Daily":
      return true; // Runs every day

    case "Weekly":
      // Check if today (e.g., 'monday') is in the task.weekDays array
      const currentDayName = today.format("dddd").toLowerCase();
      return task.weekDays.includes(currentDayName);

    case "Fortnightly":
      // Runs every 14 days from start date
      const daysDiff = today.diff(start, "days");
      return daysDiff % 14 === 0;

    case "Monthly":
      // Runs on the same "Date" (e.g., the 15th) every month
      return today.date() === start.date();

    case "Quarterly":
      // Runs on same date, every 3 months
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

// Main Job Function
const generateRecurringTasks = async () => {
  console.log("⏳ Running Cron: Checking for Recurring Tasks...");

  try {
    // 1. Fetch all active Recurring Tasks
    // Optimization: Only fetch tasks where startDate <= Today AND (endDate >= Today OR endDate is null)
    const now = new Date();

    const recurringTasks = await RecurringTask.find({
      startDate: { $lte: now },
      $or: [
        { endDate: { $exists: false } },
        { endDate: null },
        { endDate: { $gte: now } },
      ],
    });
    console.log(recurringTasks);
    let createdCount = 0;

    // 2. Iterate and check frequency
    for (const task of recurringTasks) {
      if (isTaskDueToday(task)) {
        // 3. Check if instance already created for today (prevent duplicates if cron restarts)
        // We look for a DelegationTask linked to this parent, created today
        const startOfDay = moment().utc().startOf("day").toDate();
        const endOfDay = moment().utc().endOf("day").toDate();

        const alreadyExists = await DelegationTask.findOne({
          recurrenceTaskId: task._id,
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        });

        if (!alreadyExists) {
          const today = moment().startOf("day");
          // 4. Create the Delegation Task (The Instance)
          const newDelegation = new DelegationTask({
            // Copy Base Fields
            title: task.title,
            description: task.description,
            assignedTo: task.assignedTo,
            assignedBy: task.assignedBy, // or System User ID
            departmentOfAssignToUser: task.departmentOfAssignToUser,
            priority: task.priority, // If you have this field

            // Set Delegation Specifics
            taskType: "DelegationTask", // Discriminator key
            // ✅ SET BOTH SAME
            startDate: today.toDate(),
            dueDate: today.toDate(),
            // dueDate: moment().utc()
            //   .add(task.taskEndDays || 0, "days")
            //   .toDate(), // Today + buffer
            recurrenceTaskId: task._id, // Link back to parent
            checklist: task.checklist.map((item) => ({
              ...item,
              isCompleted: false,
            })), // Clone checklist
            status: "Pending",
          });

          await newDelegation.save();
          createdCount++;
        }
      }
    }

    console.log(`✅ Cron Finished. Generated ${createdCount} tasks.`);
  } catch (error) {
    console.error("❌ Cron Job Error:", error);
  }
};

// Schedule: Run every day at 00:01 AM
const startCronJobs = () => {
  cron.schedule(
    "1 0 * * *", // ✅ runs daily at 12:01 AM
    generateRecurringTasks,
    {
      timezone: "Asia/Kolkata",
    }
  );
};

export default startCronJobs;
