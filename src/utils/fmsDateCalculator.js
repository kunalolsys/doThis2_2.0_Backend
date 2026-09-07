import {
  nextWorkingShiftDate,
  addWorkingDaysHoliday,
  snapToShiftTime,
  isWorkingDay,
  isHoliday,
} from "./dateCalculator.js";
import FmsTask from "../models/FmsTask.js";
import WorkShift from "../models/WorkShift.js";
import { addDays, startOfDay } from "date-fns";

/**
 * ALL 5 CASES - Department-Aware & WorkShift-Compliant Date Calculator
 */
export async function calculateFmsTaskDates(
  taskData,
  fmsStart,
  fmsEnd,
  workShiftId,
  previousTasks = [],
  userOrDeptId = null,
) {
  const {
    frequency,
    xValue = 0,
    isDependent,
    dependentOn,
    startTimeSetting,
    taskEndDays = 0,
    assignedTo,
  } = taskData || {};

  // Resolve target user/department context
  const targetUserContext = userOrDeptId || assignedTo || null;

  const freq = frequency?.trim().toLowerCase() || "";
  let startDate = await nextWorkingShiftDate(
    fmsStart,
    workShiftId,
    {},
    targetUserContext,
  );
  let dueDate = null;

  // CASE 1: "Anytime" / "Daily" / "Weekly" / "Monthly"
  if (
    freq === "anytime" ||
    freq === "daily" ||
    freq === "weekly" ||
    freq === "monthly"
  ) {
    /* Default start date initialized above */
  }
  // CASE 4: Dependent Tasks
  else if (isDependent && dependentOn) {
    const parentTask =
      previousTasks.find((t) => t.taskId === dependentOn) ||
      (await FmsTask.findOne({ taskId: dependentOn }).lean());

    if (!parentTask) {
      throw new Error(
        `DEP ERROR: Dependent parent task "${dependentOn}" not found`,
      );
    }

    const parentRef =
      parentTask.plannedDueDate || parentTask.plannedStartDate || fmsStart;
    const shiftBase = await nextWorkingShiftDate(
      parentRef,
      workShiftId,
      {},
      targetUserContext,
    );

    if (startTimeSetting === "planned-to-planned") {
      const isNegative = freq.includes("-");
      const multiplier = isNegative ? -1 : 1;

      if (freq.includes("hour")) {
        dueDate = new Date(
          shiftBase.getTime() + Math.abs(xValue) * 3600000 * multiplier,
        );
      } else {
        dueDate = await addWorkingDaysHoliday(
          parentRef,
          xValue * multiplier,
          workShiftId,
          false,
          {},
          targetUserContext,
        );
      }
    } else {
      // Actual-To-Planned (A-T-P): Dates remain NULL until parent task is actually completed
      startDate = null;
      dueDate = null;
    }
  }
  // CASE 2 & 3: Start-Based Frequencies (e.g., "Start + X Days", "Start - X Hours")
  else if (freq.startsWith("start")) {
    const shiftBase = await nextWorkingShiftDate(
      fmsStart,
      workShiftId,
      {},
      targetUserContext,
    );

    const isNegative = freq.includes("-");
    const multiplier = isNegative ? -1 : 1;

    if (freq.includes("hour")) {
      dueDate = new Date(
        shiftBase.getTime() + Math.abs(xValue) * 3600000 * multiplier,
      );
    } else {
      dueDate = await addWorkingDaysHoliday(
        fmsStart,
        xValue * multiplier,
        workShiftId,
        false,
        {},
        targetUserContext,
      );
    }
  }
  // CASE 5: Event-Based Frequencies (e.g., "Event - X Days", "Event + X Hours")
  else if (freq.startsWith("event") && fmsEnd) {
    const shiftBase = await nextWorkingShiftDate(
      fmsEnd,
      workShiftId,
      {},
      targetUserContext,
    );

    const isNegative = freq.includes("-");
    const multiplier = isNegative ? -1 : 1;

    if (freq.includes("hour")) {
      dueDate = new Date(
        shiftBase.getTime() + Math.abs(xValue) * 3600000 * multiplier,
      );
    } else {
      dueDate = await addWorkingDaysHoliday(
        fmsEnd,
        xValue * multiplier,
        workShiftId,
        false,
        {},
        targetUserContext,
      );
    }
  }

  // taskEndDays OVERRIDE (Explicit day offset from startDate)
  if (taskEndDays > 0 && startDate) {
    dueDate = await addWorkingDaysHoliday(
      startDate,
      taskEndDays,
      workShiftId,
      false,
      {},
      targetUserContext,
    );
  }

  return { startDate, dueDate };
}
export function parseFrequencyToHours(frequencyStr, xValue) {
  const freq = (frequencyStr || "").toLowerCase();
  const rawX = Number(xValue || 0);

  const isNegative = freq.includes("-");
  const multiplier = isNegative ? -1 : 1;

  if (freq.includes("day") || freq.includes("d")) {
    return { isDay: true, value: rawX * multiplier };
  } else {
    return { isDay: false, value: rawX * multiplier };
  }
}

/**
 * FIXED: Accurate Working Days & Working Shift Hours Overflow Calculator
 */
export async function calculateCalendarDurationWithShiftSnap(
  startDate,
  freqObj, // { isDay: boolean, value: number }
  workShiftId,
  userOrDeptId = null
) {
  if (!freqObj || freqObj.value === 0) return new Date(startDate);

  const workShift = await WorkShift.findById(workShiftId).lean();
  if (!workShift) throw new Error("WorkShift not found");

  let currDate = new Date(startDate);

  // 🟢 CASE A: DAYS FREQUENCY (e.g., +1 Day, +2 Days)
  if (freqObj.isDay) {
    let daysToAdd = Math.abs(freqObj.value);

    // Exact Working Days Jump (Tue, Wed, Sat, Sun skip honge)
    while (daysToAdd > 0) {
      currDate = addDays(currDate, 1);

      const holiday = await isHoliday(currDate, userOrDeptId);
      const working = await isWorkingDay(currDate, workShift, userOrDeptId);

      if (!holiday && working) {
        daysToAdd--;
      }
    }

    // Time ko EXACT Start Date ke Time par retain rakhein
    currDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
  } 
  // 🟢 CASE B: HOURS FREQUENCY (e.g., +6 Hours)
  else {
    let remainingMs = freqObj.value * 60 * 60 * 1000;

    while (remainingMs > 0) {
      const shiftStart = snapToShiftTime(currDate, workShift, true);
      const shiftEnd = snapToShiftTime(currDate, workShift, false);

      if (currDate < shiftStart) {
        currDate = shiftStart;
      }

      // Agar start time already shift end par ya aage hai -> Next Working Shift Start par shift karo
      if (currDate >= shiftEnd) {
        let nextDay = addDays(startOfDay(currDate), 1);
        currDate = await nextWorkingShiftDate(
          nextDay,
          workShiftId,
          {},
          userOrDeptId
        );
        continue;
      }

      const availableMs = shiftEnd.getTime() - currDate.getTime();

      if (remainingMs <= availableMs) {
        currDate = new Date(currDate.getTime() + remainingMs);
        remainingMs = 0;
      } else {
        remainingMs -= availableMs;
        let nextDay = addDays(startOfDay(currDate), 1);
        currDate = await nextWorkingShiftDate(
          nextDay,
          workShiftId,
          {},
          userOrDeptId
        );
      }
    }
  }

  // Final Shift Snap & Holiday Verification
  while (
    (await isHoliday(currDate, userOrDeptId)) ||
    !(await isWorkingDay(currDate, workShift, userOrDeptId))
  ) {
    let nextDay = addDays(startOfDay(currDate), 1);
    currDate = await nextWorkingShiftDate(
      nextDay,
      workShiftId,
      {},
      userOrDeptId
    );
  }

  const shiftStart = snapToShiftTime(currDate, workShift, true);
  const shiftEnd = snapToShiftTime(currDate, workShift, false);

  if (currDate < shiftStart) currDate = shiftStart;
  if (currDate > shiftEnd) currDate = shiftEnd;

  return currDate;
}
export default {
  calculateFmsTaskDates,
  calculateCalendarDurationWithShiftSnap,
};
