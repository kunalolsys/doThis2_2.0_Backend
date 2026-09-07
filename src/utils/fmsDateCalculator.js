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
/**
 * Frequency string ko dynamically hours/days multiplier me parse karta hai.
 */
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
 * Dynamic Calendar & Working Day Aware Date Calculator
 */
export async function calculateCalendarDurationWithShiftSnap(
  startDate,
  freqObj, // { isDay: boolean, value: number }
  workShiftId,
  userOrDeptId = null,
) {
  if (!freqObj || freqObj.value === 0) return startDate;

  const workShift = await WorkShift.findById(workShiftId).lean();
  if (!workShift) throw new Error("WorkShift not found");

  let targetDate;

  // 🟢 1. AGAR DAYS FREQUENCY HAI (e.g. 2 Days)
  if (freqObj.isDay) {
    // Sahi Working Days (Tuesday, Wednesday skip karke) Target Day nikalna
    const targetWorkingDay = await addWorkingDaysHoliday(
      startDate,
      freqObj.value,
      workShiftId,
      false,
      {},
      userOrDeptId,
    );

    // Target Working Day par Time ko original start time ke saath match karna
    targetDate = new Date(targetWorkingDay);
    targetDate.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
  }
  // 🟢 2. AGAR HOURS FREQUENCY HAI (e.g. 5 Hours)
  else {
    targetDate = new Date(startDate.getTime() + freqObj.value * 60 * 60 * 1000);
  }

  // 🟢 3. CHECK NON-WORKING DAYS / HOLIDAYS
  while (
    (await isHoliday(targetDate, userOrDeptId)) ||
    !(await isWorkingDay(targetDate, workShift, userOrDeptId))
  ) {
    let nextDay = addDays(startOfDay(targetDate), 1);
    targetDate = await nextWorkingShiftDate(
      nextDay,
      workShiftId,
      {},
      userOrDeptId,
    );
  }

  // 🟢 4. SHIFT TIMINGS SNAP CHECK (9 AM - 6 PM Clamp)
  const shiftStart = snapToShiftTime(targetDate, workShift, true);
  const shiftEnd = snapToShiftTime(targetDate, workShift, false);

  if (targetDate < shiftStart) {
    targetDate = shiftStart;
  } else if (targetDate > shiftEnd) {
    targetDate = shiftEnd;
  }

  return targetDate;
}
export default {
  calculateFmsTaskDates,
  calculateCalendarDurationWithShiftSnap,
};
