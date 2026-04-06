import cron from "node-cron";
import moment from "moment";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import User from "../models/User.js";
import WorkShift from "../models/WorkShift.js";
import {
  snapToShiftTime,
  isWorkingDay,
  isHoliday,
} from "../utils/dateCalculator.js";
import { startOfDay } from "date-fns";

// 🔥 FMS Instance Task Visibility Cron (separate from regular tasks)
const makeFmsTasksVisible = async () => {
  console.log("👁️  [FMS TASK VISIBILITY] Checking...", new Date().toISOString());

  try {
    const now = new Date();
    const todayStart = moment().startOf("day").toDate();

    // Get active users with shifts
    const usersWithShifts = await User.find({ isActive: true })
      .populate("assignShift")
      .lean();

    let updatedCount = 0;
    let processedUsers = 0;

    for (const user of usersWithShifts) {
      processedUsers++;
      if (!user.assignShift) continue;

      const workShift = user.assignShift;
      const shiftStartToday = snapToShiftTime(now, workShift, true);
      const shiftEndToday = snapToShiftTime(now, workShift, false);

      // Only if shift started today
      if (now >= shiftStartToday) {
        // FMS Instance Tasks only
        const fmsTasksToCheck = await FmsInstanceTask.find({
          assignedTo: user._id,
          isVisible: { $ne: true },
          status: { $in: ['Upcoming', 'Pending', 'Delayed', 'Overdue'] },
          $or: [
            {
              plannedStartDate: {
                $gte: todayStart,
                $lte: shiftEndToday,
              },
            },
            {
              status: "Upcoming",
            },
          ],
        }).lean();

        let validTasks = 0;
        for (const task of fmsTasksToCheck) {
          const taskDate = startOfDay(new Date(task.plannedStartDate));
          const isTaskHoliday = await isHoliday(taskDate);
          
          if (!isTaskHoliday && isWorkingDay(taskDate, workShift)) {
            await FmsInstanceTask.findByIdAndUpdate(task._id, {
              isVisible: true,
              updatedAt: now,
              visibleFrom: now,
            });
            validTasks++;
          }
        }

        updatedCount += validTasks;
        if (validTasks > 0) {
          console.log(`✅ FMS: Made ${validTasks} tasks VISIBLE for ${user.name}`);
        }
      }
    }

    console.log(`📊 [FMS VISIBILITY] ${processedUsers} users | ${updatedCount} tasks | ${new Date().toISOString()}`);
  } catch (error) {
    console.error("❌ FMS Visibility Cron Error:", error);
  }
};

// Hide FMS tasks after shift
const hideFmsCompletedShiftTasks = async () => {
  console.log("🔒 [FMS HIDE CRON] Overnight cleanup...");
  
  try {
    const now = new Date();

    const usersWithShifts = await User.find({ isActive: true })
      .populate("assignShift")
      .lean();

    let hiddenCount = 0;

    for (const user of usersWithShifts) {
      if (!user.assignShift) continue;

      const workShift = user.assignShift;
      const shiftEndToday = snapToShiftTime(now, workShift, false);

      if (now > shiftEndToday) {
        const result = await FmsInstanceTask.updateMany(
          {
            assignedTo: user._id,
            isVisible: true,
            status: { $nin: ["Completed"] },
            plannedStartDate: { $gt: now },
          },
          {
            isVisible: false,
            updatedAt: now,
          },
        );

        hiddenCount += result.modifiedCount;
      }
    }

    console.log(`📊 FMS Hid ${hiddenCount} tasks`);
  } catch (error) {
    console.error("❌ FMS Hide Error:", error);
  }
};

const startFmsVisibilityCron = () => {
  // Same schedule as main cron
  cron.schedule('*/5 9-18 * * 1-5', makeFmsTasksVisible, {
    timezone: "Asia/Kolkata",
  });

  // Hide at night
  cron.schedule('0 18 * * *', hideFmsCompletedShiftTasks, {
    timezone: "Asia/Kolkata"
  });
  
  console.log("👁️  FMS Instance Task Visibility Cron Started ✅");
};

export default startFmsVisibilityCron;

