import moment from "moment";
import { Holiday } from "../models/Holiday.js";
import WorkShift from "../models/WorkShift.js";
import {
  startOfDay,
  endOfDay,
  isSameDay,
  addDays,
  format,
  parse,
} from "date-fns";
import ScheduleHolidayTask from "../models/ScheduleHolidayTask.js";

// ==================== UTILITY HELPERS ====================

/**
 * Check if date is a holiday
 */
// export async function isHoliday(date) {
//   const startDay = startOfDay(new Date(date));
//   const holiday = await Holiday.findOne({ date: startDay })
//   console.log(holiday,startDay);
//   return !!holiday;
// }
export async function isHoliday(date) {
  const startDay = startOfDay(new Date(date));
  const endDay = endOfDay(new Date(date));

  const holiday = await Holiday.findOne({
    date: {
      $gte: startDay,
      $lte: endDay,
    },
  });

  // console.log("CHECK HOLIDAY:", {
  //   input: date,
  //   startDay,
  //   endDay,
  //   found: !!holiday,
  // });

  return !!holiday;
}
/**
 * Check if day is working day per workShift
 */
export function isWorkingDay(date, workShift) {
  if (!workShift?.workingDays) return false;

  const dayName = format(date, "EEEE").toLowerCase(); // 'monday'
  return workShift.workingDays[dayName];
}

/**
 * Snap date to shift startTime or endTime (same day)
 */
export function snapToShiftTime(date, workShift, isStart = true) {
  const day = startOfDay(new Date(date));
  const timeStr = isStart ? workShift.startTime : workShift.endTime;

  if (!timeStr) return day;

  // Parse HH:MM → add to day
  const [hours, minutes] = timeStr.split(":").map(Number);
  const snapped = new Date(day);
  snapped.setHours(hours, minutes, 0, 0);

  return snapped;
}

/**
 * Find NEXT working shift START time on/after baseDate
 * Skips holidays + non-working days
 */
export async function nextWorkingShiftDate(
  baseDate,
  workShiftId,
  options = {},
) {
  const { skipHolidays = true } = options;
  let candidate = startOfDay(new Date(baseDate));

  // Fetch workShift once
  const workShift = await WorkShift.findById(workShiftId);
  if (!workShift) throw new Error("WorkShift not found");

  while (true) {
    // Skip holidays first
    if (skipHolidays && (await isHoliday(candidate))) {
      candidate = addDays(candidate, 1);
      continue;
    }

    // Check working day
    if (isWorkingDay(candidate, workShift)) {
      return snapToShiftTime(candidate, workShift, true); // shift start
    }

    // Next day
    candidate = addDays(candidate, 1);
  }
}

/**
 * Add N WORKING DAYS from startDate
 * Returns end-of-shift on target day
 */
export async function addWorkingDaysHoliday(
  startDate,
  daysCount,
  workShiftId,
  isDep = false,
  options = {},
) {
  if (!daysCount || daysCount <= 0) return null;

  const { skipHolidays = true } = options;

  const workShift = await WorkShift.findById(workShiftId);
  if (!workShift) throw new Error("WorkShift not found");

  let current = new Date(startDate);

  // =====================================================
  // ✅ STEP 1: CORRECT DAY COUNT LOGIC
  // =====================================================
  let remainingDays = daysCount - 1;

  while (remainingDays > 0) {
    current = addDays(current, 1);

    // if (skipHolidays && (await isHoliday(current))) continue;
    // if (!isWorkingDay(current, workShift)) continue;

    remainingDays--;
  }

  // =====================================================
  // ✅ STEP 2: APPLY HOLIDAY LOGIC ONLY IF DEPENDENT
  // =====================================================
  // if (!isDep) {
  //   return snapToShiftTime(current, workShift, false);
  // }

  const schedule = await ScheduleHolidayTask.findOne();
  if (!schedule) {
    return snapToShiftTime(current, workShift, false);
  }
console.log(schedule.holidayAction)
  const holidayAction = schedule.holidayAction || "AFTER";

  // =====================================================
  // ✅ STEP 3: FINAL DATE HOLIDAY ADJUSTMENT
  // =====================================================
 // =====================================================
// ✅ STEP 3: FINAL DATE ADJUSTMENT (ONLY IF INVALID DAY)
// =====================================================
const isFinalHoliday = await isHoliday(current);
const isFinalWorkingDay = isWorkingDay(current, workShift);
console.log(current,isFinalHoliday,isFinalWorkingDay)
if (isFinalHoliday || !isFinalWorkingDay) {
  if (holidayAction === "BEFORE") {
    do {
      current = addDays(current, -1);
    } while (
      (await isHoliday(current)) ||
      !isWorkingDay(current, workShift)
    );
  }

  if (holidayAction === "AFTER") {
    do {
      current = addDays(current, 1);
    } while (
      (await isHoliday(current)) ||
      !isWorkingDay(current, workShift)
    );
  }
}

  return snapToShiftTime(current, workShift, true);
}
// export async function addWorkingDaysHoliday(
//   startDate,
//   workShiftId
// ) {
//   let current = new Date(startDate);

//   const workShift = await WorkShift.findById(workShiftId);
//   if (!workShift) throw new Error("WorkShift not found");

//   // ✅ get schedule config
//   const schedule = await ScheduleHolidayTask.findOne();
//   const holidayAction = schedule?.holidayAction || "AFTER";

//   let holidayDate = null;

//   // 🔍 find nearest holiday (next 30 days)
//   for (let i = 0; i < 30; i++) {
//     const checkDate = addDays(current, i);
//     if (await isHoliday(checkDate)) {
//       holidayDate = checkDate;
//       break;
//     }
//   }

//   // fallback
//   if (!holidayDate) {
//     return snapToShiftTime(current, workShift, false);
//   }

//   // ================= LOGIC =================

//   if (holidayAction === "BEFORE") {
//     current = addDays(holidayDate, -1);

//     while (
//       (await isHoliday(current)) ||
//       !isWorkingDay(current, workShift)
//     ) {
//       current = addDays(current, -1);
//     }
//   }

//   if (holidayAction === "AFTER") {
//     current = addDays(holidayDate, 1);

//     while (
//       (await isHoliday(current)) ||
//       !isWorkingDay(current, workShift)
//     ) {
//       current = addDays(current, 1);
//     }
//   }

//   return snapToShiftTime(current, workShift, false);
// }
export async function addWorkingDays(
  startDate,
  daysCount,
  workShiftId,
  options = {},
) {
  console.log("run");

  if (!daysCount || daysCount <= 0) return null;

  const { skipHolidays = true } = options;

  let current = new Date(startDate);

  const workShift = await WorkShift.findById(workShiftId);
  if (!workShift) throw new Error("WorkShift not found");

  // ✅ FIXED LOGIC
  let remainingDays = daysCount - 1;

  while (remainingDays > 0) {
    current = addDays(current, 1);

    if (skipHolidays && (await isHoliday(current))) continue;
    if (!isWorkingDay(current, workShift)) continue;

    remainingDays--;
  }

  // Return END of shift on target day
  return snapToShiftTime(current, workShift, false);
}
// ==================== BACKWARD COMPATIBILITY ====================
export const calculateActivationDate = (baseDate, frequency, xValue) => {
  const date = moment(baseDate);
  if (frequency === "T+X in days") {
    return date.add(xValue, "days").toDate();
  } else if (frequency === "T-X in hours") {
    return date.subtract(xValue, "hours").toDate();
  }
  return date.toDate();
};

// ==================== EXPORTS ====================
export default {
  isHoliday,
  isWorkingDay,
  snapToShiftTime,
  nextWorkingShiftDate,
  addWorkingDays,
  calculateActivationDate,
  addWorkingDaysHoliday,
};
