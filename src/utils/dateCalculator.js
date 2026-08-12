import moment from "moment";
import { Holiday } from "../models/Holiday.js";
import WorkShift from "../models/WorkShift.js";
import Department from "../models/Department.js";
import WorkingWeek from "../models/WorkingWeek.js";
import User from "../models/User.js";
import ScheduleHolidayTask from "../models/ScheduleHolidayTask.js";

import { startOfDay, endOfDay, addDays, format } from "date-fns";

// ==================== INTERNAL RESOLVER HELPERS ====================

/**
 * Helper to safely extract Department ID from userId, Department object, or string ID.
 */
async function resolveDepartmentId(userOrDeptId) {
  if (!userOrDeptId) return null;

  // If passed an object (User doc or Department doc)
  if (typeof userOrDeptId === "object") {
    if (userOrDeptId.department) {
      const dept = userOrDeptId.department;
      return dept._id || (Array.isArray(dept) ? dept[0]?._id : null);
    }
    return userOrDeptId._id || null;
  }

  // If passed a String ID, check if it belongs to a User
  const user = await User.findById(userOrDeptId).select("department").lean();
  if (user && user.department) {
    const dept = user.department;
    return Array.isArray(dept) ? dept[0] : dept;
  }

  // Fallback: Treat string as direct Department ID
  return userOrDeptId;
}

// ==================== DEPARTMENT SCHEDULE HELPER ====================

export const getDepartmentSchedule = async (userId) => {
  if (!userId) return null;

  const user = await User.findById(userId).populate("department").lean();
  if (!user) {
    throw new Error("User not found");
  }

  const department = user.department;
  const deptId =
    department?._id || (Array.isArray(department) ? department[0]?._id : null);

  let workingDays = null;
  let scheduleType = "GLOBAL_DEFAULT";

  if (department && department.workingWeekDays) {
    workingDays = department.workingWeekDays;
    scheduleType = "DEPARTMENT_CUSTOM";
  } else {
    const globalWeek = await WorkingWeek.findOne().lean();
    workingDays = globalWeek?.workingDays || {
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
    };
  }

  const holidayFilter = {
    $or: [
      { isGlobal: true },
      ...(deptId ? [{ applicableDepartments: deptId }] : []),
    ],
  };

  const holidays = await Holiday.find(holidayFilter)
    .populate("applicableDepartments", "name")
    .sort({ date: 1 })
    .lean();

  return {
    department: department ? { _id: deptId, name: department.name } : null,
    scheduleType,
    workingDays,
    holidays,
  };
};

// ==================== REFACTORED SYSTEM UTILITIES ====================

/**
 * Check if date is a holiday (Department-Specific OR Global)
 */
export async function isHoliday(date, userOrDeptId = null) {
  const startDay = startOfDay(new Date(date));
  const endDay = endOfDay(new Date(date));

  const deptId = await resolveDepartmentId(userOrDeptId);

  const holidayFilter = {
    date: {
      $gte: startDay,
      $lte: endDay,
    },
    $or: [
      { isGlobal: true },
      ...(deptId ? [{ applicableDepartments: deptId }] : []),
    ],
  };

  const holiday = await Holiday.findOne(holidayFilter).lean();
  return !!holiday;
}

/**
 * Check if day is a working day
 * Priority: Department Custom Schedule -> Global WorkingWeek
 */
export async function isWorkingDay(
  date,
  workShift = null,
  userOrDeptId = null,
) {
  const dayName = format(new Date(date), "EEEE").toLowerCase(); // 'monday'

  // Handling parameter shift if workShift is passed as userOrDeptId
  let targetDeptOrUser = userOrDeptId;
  if (!targetDeptOrUser && workShift && typeof workShift !== "object") {
    targetDeptOrUser = workShift;
  }

  const deptId = await resolveDepartmentId(targetDeptOrUser);

  // 1. Check Department Custom Working Week
  if (deptId) {
    const department = await Department.findById(deptId)
      .select("workingWeekDays")
      .lean();
    if (department && department.workingWeekDays) {
      return Boolean(department.workingWeekDays[dayName]);
    }
  }

  // 2. Fallback to Global WorkingWeek Schedule
  const globalWeek = await WorkingWeek.findOne().lean();
  if (globalWeek?.workingDays) {
    return Boolean(globalWeek.workingDays[dayName]);
  }

  // Fallback default (Mon-Fri)
  return dayName !== "saturday" && dayName !== "sunday";
}

/**
 * Snap date to shift startTime or endTime (same day)
 */
export function snapToShiftTime(date, workShift, isStart = true) {
  const day = startOfDay(new Date(date));
  const timeStr = isStart ? workShift?.startTime : workShift?.endTime;

  if (!timeStr) return day;

  const [hours, minutes] = timeStr.split(":").map(Number);
  const snapped = new Date(day);
  snapped.setHours(hours, minutes, 0, 0);

  return snapped;
}

/**
 * Find NEXT working shift START time on/after baseDate
 */
export async function nextWorkingShiftDate(
  baseDate,
  workShiftId,
  options = {},
  userOrDeptId = null,
) {
  const { skipHolidays = true } = options;
  let candidate = startOfDay(new Date(baseDate));

  const workShift = await WorkShift.findById(workShiftId).lean();
  if (!workShift) throw new Error("WorkShift not found");

  while (true) {
    if (skipHolidays && (await isHoliday(candidate, userOrDeptId))) {
      candidate = addDays(candidate, 1);
      continue;
    }

    if (await isWorkingDay(candidate, workShift, userOrDeptId)) {
      return snapToShiftTime(candidate, workShift, true);
    }

    candidate = addDays(candidate, 1);
  }
}

/**
 * 🟢 FIXED: Add N WORKING DAYS from startDate incorporating Department Holiday & Working Week Rules
 */
export async function addWorkingDaysHoliday(
  startDate,
  daysCount,
  workShiftId,
  isDep = false,
  options = {},
  userOrDeptId = null,
) {
  if (daysCount === null || daysCount === undefined || daysCount === "") {
    return null;
  }

  const numericDays = Number(daysCount);

  if (!Number.isFinite(numericDays)) {
    return null;
  }

  const { skipHolidays = true } = options;

  const workShift = await WorkShift.findById(workShiftId).lean();

  if (!workShift) {
    throw new Error("WorkShift not found");
  }

  const isNegative = numericDays < 0;
  const step = isNegative ? -1 : 1;

  const dayOffset = Math.abs(numericDays) - 1;

  let current = new Date(startDate);

  if (dayOffset > 0) {
    current = addDays(current, step * dayOffset);
  }

  while (true) {
    const holiday = skipHolidays && (await isHoliday(current, userOrDeptId));

    const working = await isWorkingDay(current, workShift, userOrDeptId);

    if (!holiday && working) {
      break;
    }

    // Always move forward to the next valid date
    current = addDays(current, 1);
  }

  return snapToShiftTime(current, workShift, false);
}

export async function addWorkingDays(
  startDate,
  daysCount,
  workShiftId,
  options = {},
  userOrDeptId = null,
) {
  if (!daysCount || daysCount <= 0) return null;

  const { skipHolidays = true } = options;

  let current = new Date(startDate);

  const workShift = await WorkShift.findById(workShiftId).lean();
  if (!workShift) throw new Error("WorkShift not found");

  let remainingDays = daysCount - 1;

  while (remainingDays > 0) {
    current = addDays(current, 1);

    if (skipHolidays && (await isHoliday(current, userOrDeptId))) continue;
    if (!(await isWorkingDay(current, workShift, userOrDeptId))) continue;

    remainingDays--;
  }

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
  getDepartmentSchedule,
};
