import {
  nextWorkingShiftDate,
  addWorkingDaysHoliday,
} from "./dateCalculator.js";
import FmsTask from "../models/FmsTask.js";

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

export default { calculateFmsTaskDates };
