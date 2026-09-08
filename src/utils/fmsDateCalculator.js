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

  const targetUserContext = userOrDeptId || assignedTo || null;
  const freq = frequency?.trim().toLowerCase() || "";

  let startDate = await nextWorkingShiftDate(
    fmsStart,
    workShiftId,
    {},
    targetUserContext,
  );
  let dueDate = null;

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
      startDate = null;
      dueDate = null;
    }
  } else if (freq.startsWith("start")) {
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
  } else if (freq.startsWith("event") && fmsEnd) {
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
 * FIXED: 24-Hour Calendar Duration + Holiday/Shift-Snap Aware Calculator
 */
export async function calculateCalendarDurationWithShiftSnap(
  startDate,
  freqObj,
  workShiftId,
  userOrDeptId = null,
) {
  if (!freqObj || freqObj.value === 0) return new Date(startDate);

  const workShift = await WorkShift.findById(workShiftId).lean();
  if (!workShift) throw new Error("WorkShift not found");

  let targetDate = new Date(startDate);

  // 1. CALENDAR DURATION ADDITION
  if (freqObj.isDay) {
    targetDate = new Date(
      startDate.getTime() + freqObj.value * 24 * 60 * 60 * 1000,
    );
  } else {
    let remainingMs = freqObj.value * 60 * 60 * 1000;
    let currStart = new Date(startDate);

    while (remainingMs > 0) {
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
          userOrDeptId,
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
          userOrDeptId,
        );
      }
    }
    targetDate = currStart;
  }

  // 2. TARGET DATE HOLIDAY / NON-WORKING DAY CHECK
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

  // 3. SHIFT TIMINGS SNAP
  const shiftStart = snapToShiftTime(targetDate, workShift, true);
  const shiftEnd = snapToShiftTime(targetDate, workShift, false);

  if (targetDate < shiftStart) targetDate = shiftStart;
  if (targetDate > shiftEnd) targetDate = shiftEnd;

  return targetDate;
}

export default {
  calculateFmsTaskDates,
  parseFrequencyToHours,
  calculateCalendarDurationWithShiftSnap,
};
