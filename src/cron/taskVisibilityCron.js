import cron from "node-cron";
import moment from "moment-timezone";
import Task from "../models/Task.js";
import User from "../models/User.js";
import WorkShift from "../models/WorkShift.js";
import {
  snapToShiftTime,
  isWorkingDay,
  isHoliday,
  nextWorkingShiftDate,
} from "../utils/dateCalculator.js";
import { format, startOfDay } from "date-fns";

// 🔥 MAIN CRON: Make tasks VISIBLE at shift start
const makeTasksVisible = async () => {
  console.log("⏰ [TASK VISIBILITY CRON] Checking shift starts...", {
    timestamp: new Date().toISOString(),
  });

  try {
    const now = new Date();

    // Find all active users with shifts and populated department
    const usersWithShifts = await User.find({ isActive: true })
      .populate("assignShift")
      .populate("department")
      .lean();

    let updatedCount = 0;
    let processedUsers = 0;

    for (const user of usersWithShifts) {
      processedUsers++;
      if (!user.assignShift) {
        continue;
      }

      const workShift = user.assignShift;
      const deptId = user.department?._id || user.department || null;

      const shiftStartToday = snapToShiftTime(now, workShift, true);

      // Only run if current time >= shift start today
      if (now >= shiftStartToday) {
        const todayStart = moment(now)
          .tz("Asia/Kolkata")
          .startOf("day")
          .toDate();
        const shiftEndToday = snapToShiftTime(now, workShift, false);

        const tasksToCheck = await Task.find({
          assignedTo: user._id,
          isVisible: { $ne: true },
          isDeleted: { $ne: true },
          status: { $in: ["Pending", "Delayed", "Overdue", "Upcoming"] },
          $or: [
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

        let validTaskIds = [];

        for (const task of tasksToCheck) {
          // =====================================================
          // ✅ NORMALIZED DATES (IST BOUNDARY)
          // =====================================================
          const today = moment(now).tz("Asia/Kolkata").startOf("day").toDate();
          const taskDeptId = task.departmentOfAssignToUser || deptId;

          // =====================================================
          // ✅ TODAY MUST BE VALID WORKING DAY FOR DEPT (FIXED)
          // =====================================================
          const isTodayHoliday = await isHoliday(today, taskDeptId || user._id);
          const isTodayWorking = await isWorkingDay(
            today,
            workShift._id,
            taskDeptId || user._id,
          );

          if (isTodayHoliday || !isTodayWorking) {
            continue;
          }

          // =====================================================
          // ✅ FIND FIRST VALID WORKING DAY AFTER TASK START DATE (FIXED)
          // =====================================================
          const nextShiftDate = await nextWorkingShiftDate(
            task.startDate,
            workShift._id,
            {},
            taskDeptId || user._id,
          );
          const firstVisibleDay = moment(nextShiftDate)
            .tz("Asia/Kolkata")
            .startOf("day")
            .toDate();

          /**
           * =====================================================
           * ✅ MAIN RULE
           * =====================================================
           * Task should become visible if:
           * 1. Today >= first valid working day
           * 2. (Fix) Overdue tasks stay visible even if today > dueDate
           */
          let withinVisibleWindow = false;

          if (task.isDependent) {
            withinVisibleWindow =
              task.startDate && now >= new Date(task.startDate);
          } else {
            withinVisibleWindow = today >= firstVisibleDay;
          }

          if (!withinVisibleWindow) {
            continue;
          }

          // Avoid processing if already visible
          if (task.isVisible) {
            continue;
          }

          validTaskIds.push(task._id);
        }

        // =====================================================
        // ✅ BATCH UPDATE VISIBLE TASKS
        // =====================================================
        if (validTaskIds.length > 0) {
          await Task.updateMany(
            { _id: { $in: validTaskIds } },
            {
              $set: {
                isVisible: true,
                visibleFrom: now,
                updatedAt: now,
              },
            },
          );

          updatedCount += validTaskIds.length;
          console.log(
            `✅ Made ${validTaskIds.length} task(s) VISIBLE for ${user.name || user._id}`,
          );
        }
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
            $set: {
              isVisible: false,
              updatedAt: now,
            },
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

// Schedule: Every 10 seconds in Asia/Kolkata timezone
const startVisibilityCron = () => {
  cron.schedule("*/10 * * * * *", makeTasksVisible, {
    timezone: "Asia/Kolkata",
  });

  console.log("👁️ Task Visibility Cron Started");
};

export default startVisibilityCron;
