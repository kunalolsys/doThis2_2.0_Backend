import cron from "node-cron";
import moment from "moment";
import Task from "../models/Task.js";
import User from "../models/User.js";
import WorkShift from "../models/WorkShift.js";
import {
  snapToShiftTime,
  isWorkingDay,
  isHoliday,
} from "../utils/dateCalculator.js";
import { startOfDay } from "date-fns";

// 🔥 MAIN CRON: Make tasks VISIBLE at shift start
const makeTasksVisible = async () => {
  // console.log("⏰ [TASK VISIBILITY CRON] Checking shift starts...", { timestamp: new Date().toISOString() });

  try {
    const now = new Date();

    // Find all users who have shift starting TODAY
    const usersWithShifts = await User.find({ isActive: true })
      .populate("assignShift")
      .lean();

    // console.log(`👥 Found ${usersWithShifts.length} active users with shifts`);

    let updatedCount = 0;
    let processedUsers = 0;

    for (const user of usersWithShifts) {
      processedUsers++;
      if (!user.assignShift) {
        // console.log(`⚠️  User ${user.name} (${user.email}) has no shift - skipping`);
        continue;
      }

      const workShift = user.assignShift;
      const shiftStartToday = snapToShiftTime(now, workShift, true);

      // console.log(`🔍 Processing ${user.name} (${workShift.name}): shiftStart=${shiftStartToday.toLocaleTimeString()}, now=${now.toLocaleTimeString()}`);

      // Only run if current time >= shift start today
      if (now >= shiftStartToday) {
        // 🔥 Make user's pending tasks VISIBLE (today's working day)
        // 🔥 Pre-fetch today's holidays
        const todayStart = moment().startOf("day").toDate();
        const isTodayHoliday = await isHoliday(now);

        // 🔥 Check if task.startDate is WITHIN current shift window
        const shiftStartToday = snapToShiftTime(now, workShift, true);
        const shiftEndToday = snapToShiftTime(now, workShift, false);

        // 🔥 ADDITIONAL: Per-task workshift day + holiday check
        // const tasksToCheck = await Task.find({
        //   assignedTo: user._id,
        //   isVisible: { $ne: true },
        //   status: { $in: ['Pending', 'Delayed', 'Overdue',] },
        //   startDate: {
        //     $gte: todayStart,
        //     $lte: shiftEndToday
        //   }
        // }).lean();

        const tasksToCheck = await Task.find({
          assignedTo: user._id,
          isVisible: { $ne: true },
          status: { $in: ["Pending", "Delayed", "Overdue", "Upcoming"] },
          $or: [
            // ✅ Today's tasks (existing logic)
            {
              startDate: {
                $gte: todayStart,
                $lte: shiftEndToday,
              },
            },
            {
              status: { $in: ["Pending", "Delayed", "Overdue", "Upcoming"] },
            },
          ],
        }).lean();
        let validTasks = 0;
        for (const task of tasksToCheck) {
          const taskDate = startOfDay(new Date(task.startDate));
          const isTaskHoliday = await isHoliday(taskDate);
          if (!isTaskHoliday && isWorkingDay(taskDate, workShift)) {
            await Task.findByIdAndUpdate(task._id, {
              isVisible: true,
              updatedAt: now,
              visibleFrom: now,
            });
            validTasks++;
          }
        }

        updatedCount += validTasks;
        // console.log(`✅ Made ${validTasks} tasks VISIBLE for ${user.name} (${workShift.name})`);

        if (isTodayHoliday) {
          // console.log(`⛔ TODAY IS HOLIDAY - No tasks made visible for ${user.name}`);
        } else if (validTasks === 0) {
          // console.log(`ℹ️  No tasks to show for ${user.name}`);
        }
      } else {
        // console.log(`⏳ Shift not started for ${user.name}: ${now.toLocaleTimeString()} < ${shiftStartToday.toLocaleTimeString()}`);
      }
    }

    console.log(
      `📊 [SUMMARY] Processed ${processedUsers}/${usersWithShifts.length} users | Updated ${updatedCount} tasks | ${new Date().toISOString()}`,
    );
  } catch (error) {
    console.error("❌ [CRITICAL] Visibility Cron Error:", error);
  }
};

// 🔥 HIDE TASKS at shift end (optional - or use status logic)
const hideCompletedShiftTasks = async () => {
  console.log("🔒 [TASK VISIBILITY CRON] Hiding overnight tasks...", {
    timestamp: new Date().toISOString(),
  });

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

      console.log(
        `🔍 ${user.name} shift end: ${shiftEndToday.toLocaleTimeString()} | now: ${now.toLocaleTimeString()}`,
      );

      // If past shift end, hide non-completed future tasks
      if (now > shiftEndToday) {
        const result = await Task.updateMany(
          {
            assignedTo: user._id,
            isVisible: true,
            status: { $nin: ["Completed"] },
            startDate: { $gt: now }, // Tomorrow's tasks
          },
          {
            isVisible: false,
            updatedAt: now,
          },
        );

        hiddenCount += result.modifiedCount;
        if (result.modifiedCount > 0) {
          console.log(`✅ Hid ${result.modifiedCount} tasks for ${user.name}`);
        }
      }
    }

    console.log(`📊 Hid ${hiddenCount} tasks total`);
  } catch (error) {
    console.error("❌ [CRITICAL] Hide Tasks Error:", error);
  }
};

// Schedule: Every minute during working hours (more efficient than 00:01)
const startVisibilityCron = () => {
  // Check every 5 minutes during 9AM-6PM IST
  // cron.schedule('*/5 9-18 * * 1-5', makeTasksVisible, {
  cron.schedule("*/5 * * * * *", makeTasksVisible, {
    // cron.schedule("*/3 * * * * *", makeTasksVisible, {
    timezone: "Asia/Kolkata",
  });

  // Hide at night
  // cron.schedule('0 18 * * *', hideCompletedShiftTasks, {
  //   timezone: "Asia/Kolkata"
  // });
  console.log("👁️  Task Visibility Cron Started");
};

export default startVisibilityCron;

//working
