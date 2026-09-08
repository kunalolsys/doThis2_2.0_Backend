import mongoose from "mongoose";
import dotenv from "dotenv";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import User from "../models/User.js";
import {
  isWorkingDay,
  isHoliday,
  snapToShiftTime,
  nextWorkingShiftDate,
} from "../utils/dateCalculator.js"; // Adjust relative path if needed
import {
  parseFrequencyToHours,
  calculateCalendarDurationWithShiftSnap,
} from "../utils/fmsDateCalculator.js"; // Adjust relative path if needed

dotenv.config();

// Mongoose duplicate index warnings suppresses warning
mongoose.set("strictQuery", false);

async function runAudit() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL;
    if (!mongoUri) {
      console.error("❌ MONGO_URI not found in .env file");
      process.exit(1);
    }

    console.log("⏳ Connecting to MongoDB...");
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB successfully.\n");

    console.log(
      "🔍 Scanning for mismatched Child Tasks (Actual-to-Planned & Planned-to-Planned)..."
    );

    // 🟢 FETCH UNCOMPLETED DEPENDENT CHILD TASKS ONLY (Completed tasks skipped)
    const childTasks = await FmsInstanceTask.find({
      startTimeSetting: { $in: ["actual-to-planned", "planned-to-planned"] },
      plannedStartDate: { $ne: null },
      isDependent: true,
      status: { $ne: "Completed" }, // Skip already completed child tasks
    });

    console.log(`📋 Total active child tasks found to verify: ${childTasks.length}`);

    const mismatchedTasks = [];

    for (const child of childTasks) {
      const parentTask = await FmsInstanceTask.findOne({
        fmsInstanceId: child.fmsInstanceId,
        taskId: child.dependentOn,
      });

      if (!parentTask) continue;

      let referenceDate = null;

      // 🟢 1. PICK REFERENCE DATE ACCORDING TO DEPENDENCY TYPE
      if (child.startTimeSetting === "actual-to-planned") {
        // Actual-to-Planned strictly requires Completed Parent
        if (parentTask.status !== "Completed" || !parentTask.actualCompleteDate) {
          continue;
        }
        referenceDate = new Date(parentTask.actualCompleteDate);
      } else if (child.startTimeSetting === "planned-to-planned") {
        // Planned-to-Planned relies on Parent's Planned Due Date
        if (!parentTask.plannedDueDate) continue;
        referenceDate = new Date(parentTask.plannedDueDate);
      }

      if (!referenceDate) continue;

      const workShiftUser = await User.findById(child.assignedTo).populate(
        "assignShift"
      );
      const shift = workShiftUser?.assignShift;

      if (!shift) continue;

      const taskDeptContext =
        child.departmentOfAssignToUser ||
        workShiftUser?.department ||
        workShiftUser?._id;

      // 🟢 2. RE-CALCULATE USING LATEST UTILITY LOGIC
      let expectedStartDate = new Date(referenceDate);

      const isTodayWorking = await isWorkingDay(
        expectedStartDate,
        shift,
        taskDeptContext
      );
      const isTodayHoli = await isHoliday(expectedStartDate, taskDeptContext);
      const shiftEnd = snapToShiftTime(expectedStartDate, shift, false);

      if (!isTodayWorking || isTodayHoli || expectedStartDate >= shiftEnd) {
        let nextDay = new Date(expectedStartDate);
        if (expectedStartDate >= shiftEnd) {
          nextDay.setDate(nextDay.getDate() + 1);
        }

        const nextWorkingShift = await nextWorkingShiftDate(
          nextDay,
          shift._id,
          {},
          taskDeptContext
        );

        expectedStartDate = snapToShiftTime(nextWorkingShift, shift, true);
      }

      const freqParsed = parseFrequencyToHours(child.frequency, child.xValue);

      const expectedDueDate = await calculateCalendarDurationWithShiftSnap(
        expectedStartDate,
        freqParsed,
        shift._id,
        taskDeptContext
      );

      // 🟢 3. COMPARE EXISTING VS EXPECTED (WITH 1-MIN TOLERANCE)
      const existingStart = new Date(child.plannedStartDate).getTime();
      const existingDue = new Date(child.plannedDueDate).getTime();

      const expStart = expectedStartDate.getTime();
      const expDue = expectedDueDate.getTime();

      const isMismatch =
        Math.abs(existingStart - expStart) > 60000 ||
        Math.abs(existingDue - expDue) > 60000;

      if (isMismatch) {
        mismatchedTasks.push({
          instanceTaskId: child._id,
          taskId: child.taskId,
          fmsInstanceId: child.fmsInstanceId,
          startTimeSetting: child.startTimeSetting,
          status: child.status,
          frequency: child.frequency,
          xValue: child.xValue,
          parentReferenceDate: referenceDate,
          existingDates: {
            plannedStartDate: child.plannedStartDate,
            plannedDueDate: child.plannedDueDate,
          },
          expectedCorrectDates: {
            plannedStartDate: expectedStartDate,
            plannedDueDate: expectedDueDate,
          },
        });
      }
    }

    console.log("\n=================== AUDIT RESULT ===================");
    console.log(`⚠️ Total Mismatched Tasks Found: ${mismatchedTasks.length}`);
    console.log("====================================================\n");

    console.log(JSON.stringify(mismatchedTasks, null, 2));

    await mongoose.disconnect();
    console.log("\n✅ Disconnected from MongoDB. Audit complete.");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error running audit script:", error);
    process.exit(1);
  }
}

runAudit();