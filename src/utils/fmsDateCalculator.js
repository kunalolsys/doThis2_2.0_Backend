import { addDays, startOfDay } from "date-fns";
import WorkShift from "../models/WorkShift.js";
import FmsTask from "../models/FmsTask.js";
import {
  nextWorkingShiftDate,
  snapToShiftTime,
  isWorkingDay,
  isHoliday,
} from "./dateCalculator.js";

/**
 * Frequency string ko dynamically parse karta hai.
 * Returns: { isDay: boolean, value: number }
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
 * EXACT TIME PRESERVING & CALENDAR DAYS JUMP CALCULATOR
 */
export async function calculateCalendarDurationWithShiftSnap(
  startDate,
  freqObj,
  workShiftId,
  userOrDeptId = null
) {
  if (!startDate) startDate = new Date();
  if (!freqObj || freqObj.value === 0) return new Date(startDate);

  const workShift = await WorkShift.findById(workShiftId).lean();
  if (!workShift) return new Date(startDate);

  let targetDate = new Date(startDate);

  // Preserve original exact start time (e.g., 11:49 AM)
  const origHours = startDate.getHours();
  const origMinutes = startDate.getMinutes();
  const origSeconds = startDate.getSeconds();

  // 🟢 1. CALENDAR DAYS JUMP (STRICT 24-HOUR / CALENDAR DAYS JUMP)
  if (freqObj.isDay) {
    // Direct calendar days add karein (बीच ke off-days skip nahi honge)
    targetDate = addDays(targetDate, Math.abs(freqObj.value));

    // Restore exact original time (11:49 AM)
    targetDate.setHours(origHours, origMinutes, origSeconds, 0);
  } 
  // 🟢 2. SHIFT HOURS OVERFLOW (FOR HOUR FREQUENCIES ONLY)
  else {
    let remainingMs = freqObj.value * 60 * 60 * 1000;
    let currStart = new Date(startDate);

    let safetyCounter = 0;
    while (remainingMs > 0 && safetyCounter < 50) {
      safetyCounter++;
      const shiftStart = snapToShiftTime(currStart, workShift, true);
      const shiftEnd = snapToShiftTime(currStart, workShift, false);

      if (currStart < shiftStart) {
        currStart = shiftStart;
      }

      if (currStart >= shiftEnd) {
        let nextDay = addDays(startOfDay(currStart), 1);
        currStart = await nextWorkingShiftDate(
          nextDay,
          workShiftId,
          {},
          userOrDeptId
        );
        continue;
      }

      const availableMs = shiftEnd.getTime() - currStart.getTime();

      if (remainingMs <= availableMs) {
        currStart = new Date(currStart.getTime() + remainingMs);
        remainingMs = 0;
      } else {
        remainingMs -= availableMs;
        let nextDay = addDays(startOfDay(currStart), 1);
        currStart = await nextWorkingShiftDate(
          nextDay,
          workShiftId,
          {},
          userOrDeptId
        );
      }
    }
    targetDate = currStart;
  }

  // 🟢 3. TARGET LANDING DAY HOLIDAY / NON-WORKING DAY ROLLOVER
  // Sirf tabhi next working day par jayega agar LANDING date holiday/non-working ho
  let holidayCheckCounter = 0;
  while (
    holidayCheckCounter < 30 &&
    ((await isHoliday(targetDate, userOrDeptId)) ||
      !(await isWorkingDay(targetDate, workShift, userOrDeptId)))
  ) {
    holidayCheckCounter++;
    let nextDay = addDays(startOfDay(targetDate), 1);
    targetDate = await nextWorkingShiftDate(
      nextDay,
      workShiftId,
      {},
      userOrDeptId
    );

    // Day frequency me exact original time retain rakhein
    if (freqObj.isDay) {
      targetDate.setHours(origHours, origMinutes, origSeconds, 0);
    }
  }

  // 🟢 4. SHIFT BOUNDARY CLAMP (DISABLED FOR DAY FREQUENCY TO PRESERVE TIME)
  if (!freqObj.isDay) {
    const shiftStart = snapToShiftTime(targetDate, workShift, true);
    const shiftEnd = snapToShiftTime(targetDate, workShift, false);

    if (targetDate < shiftStart) targetDate = shiftStart;
    if (targetDate > shiftEnd) targetDate = shiftEnd;
  }

  return targetDate;
}

export async function calculateFmsTaskDates(
  taskData,
  fmsStart,
  fmsEnd,
  workShiftId,
  previousTasks = [],
  userOrDeptId = null
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

  const targetUserContext = userOrDeptId || assignedTo || null;
  const freq = frequency?.trim().toLowerCase() || "";

  let startDate = await nextWorkingShiftDate(
    fmsStart,
    workShiftId,
    {},
    targetUserContext
  );
  let dueDate = null;

  const freqParsed = parseFrequencyToHours(frequency, xValue);

  if (
    freq === "anytime" ||
    freq === "daily" ||
    freq === "weekly" ||
    freq === "monthly"
  ) {
    /* Default start date initialized above */
  } else if (isDependent && dependentOn) {
    const parentTask =
      previousTasks.find((t) => t.taskId === dependentOn) ||
      (await FmsTask.findOne({ taskId: dependentOn }).lean());

    if (parentTask) {
      const parentRef =
        parentTask.plannedDueDate || parentTask.plannedStartDate || fmsStart;
      startDate = await nextWorkingShiftDate(
        parentRef,
        workShiftId,
        {},
        targetUserContext
      );

      if (startTimeSetting === "planned-to-planned") {
        dueDate = await calculateCalendarDurationWithShiftSnap(
          startDate,
          freqParsed,
          workShiftId,
          targetUserContext
        );
      } else {
        startDate = null;
        dueDate = null;
      }
    }
  } else if (freq.startsWith("start")) {
    startDate = await nextWorkingShiftDate(
      fmsStart,
      workShiftId,
      {},
      targetUserContext
    );

    dueDate = await calculateCalendarDurationWithShiftSnap(
      startDate,
      freqParsed,
      workShiftId,
      targetUserContext
    );
  } else if (freq.startsWith("event") && fmsEnd) {
    startDate = await nextWorkingShiftDate(
      fmsStart,
      workShiftId,
      {},
      targetUserContext
    );

    dueDate = await calculateCalendarDurationWithShiftSnap(
      fmsEnd,
      freqParsed,
      workShiftId,
      targetUserContext
    );
  }

  if (taskEndDays > 0 && startDate) {
    const endDaysParsed = { isDay: true, value: Number(taskEndDays) };
    dueDate = await calculateCalendarDurationWithShiftSnap(
      startDate,
      endDaysParsed,
      workShiftId,
      targetUserContext
    );
  }

  return { startDate, dueDate };
}

export default {
  calculateFmsTaskDates,
  parseFrequencyToHours,
  calculateCalendarDurationWithShiftSnap,
};