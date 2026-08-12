import cron from "node-cron";
import moment from "moment-timezone";
import { Task } from "../models/Task.js";
import User from "../models/User.js";
import {
  calculateActivationDate,
  addWorkingDays,
  nextWorkingShiftDate,
  snapToShiftTime,
} from "../utils/dateCalculator.js";

export const runDependencyCron = async () => {
  console.log("⏰ Running Cron: Checking Planned Dependencies...");

  try {
    // 1. Fetch tasks that are dependent, planned-to-planned, pending, and not yet started
    const p2pTasks = await Task.find({
      isDependent: true,
      "dependencyConfig.startTimeSetting": "planned-to-planned",
      status: "Pending",
      startDate: null,
      isDeleted: { $ne: true },
    }).populate("dependencyConfig.taskDependent");

    const now = moment().tz("Asia/Kolkata");

    for (const childTask of p2pTasks) {
      try {
        const parentTask = childTask.dependencyConfig?.taskDependent;

        if (!parentTask || !parentTask.startDate) continue;

        // 2. Calculate Target Date (Parent ki PLANNED Start Date se)
        const targetDate = calculateActivationDate(
          parentTask.startDate,
          childTask.dependencyConfig.isDependentFrequency,
          childTask.dependencyConfig.xValue,
        );

        // 3. Agar Time ho gaya hai -> Activate Child
        if (now.isSameOrAfter(moment(targetDate))) {
          console.log(
            `🚀 Activating P2P Task: ${childTask.title || childTask.TaskId}`,
          );

          // Resolve child task user and workshift context
          const assignedUser = await User.findById(childTask.assignedTo)
            .populate("assignShift")
            .lean();

          if (assignedUser?.assignShift) {
            const workShift = assignedUser.assignShift;

            // Align start date to user shift and department schedule
            const shiftStart = await nextWorkingShiftDate(
              new Date(),
              workShift._id,
              {},
              assignedUser._id,
            );

            childTask.startDate = shiftStart;

            // Set due date using department-aware workshift days
            if (childTask.taskEndDays && childTask.taskEndDays > 0) {
              childTask.dueDate = await addWorkingDays(
                shiftStart,
                childTask.taskEndDays,
                workShift._id,
                {},
                assignedUser._id,
              );
            } else {
              childTask.dueDate = snapToShiftTime(shiftStart, workShift, false);
            }
          } else {
            // Fallback if no workshift is assigned
            childTask.startDate = new Date();
            if (childTask.taskEndDays) {
              childTask.dueDate = moment()
                .add(childTask.taskEndDays, "days")
                .toDate();
            }
          }

          childTask.isDependent = false; // Dependency resolved
          childTask.updatedAt = new Date();

          await childTask.save();
        }
      } catch (singleTaskError) {
        console.error(
          `❌ Error processing dependency for task ${childTask?._id}:`,
          singleTaskError.message,
        );
      }
    }
  } catch (error) {
    console.error("Cron Error in runDependencyCron:", error);
  }
};

// Schedule: Every hour at minute 0
cron.schedule("0 * * * *", runDependencyCron, {
  timezone: "Asia/Kolkata",
});

export default runDependencyCron;
