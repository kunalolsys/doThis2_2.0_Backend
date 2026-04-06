import { nextWorkingShiftDate, addWorkingDaysHoliday } from './dateCalculator.js';
import FmsTask from '../models/FmsTask.js';
import ScheduleHolidayTask from '../models/ScheduleHolidayTask.js';
import { startOfDay } from 'date-fns';

/**
 * EXACT BRD FMS LAUNCH - ALL CONDITIONS ✓
 */
export async function calculateFmsTaskDates(taskData, fmsStart, fmsEnd, workShiftId, previousTasks = []) {
  const { 
    frequency, 
    xValue = 0, 
    isDependent, 
    dependentOn, 
    startTimeSetting, 
    taskEndDays = 0 
  } = taskData;
  
  const absX = Math.abs(xValue);
  const sign = xValue >= 0 ? 1 : -1;
  const freq = frequency?.toLowerCase() || '';
  
  let startDate, dueDate;

  // ===== DEPENDENT (PARENT MUST EXIST) =====
  if (isDependent && dependentOn) {
    let parentTask = previousTasks.find(t => t.taskId === dependentOn);
    if (!parentTask) {
      parentTask = await FmsTask.findOne({ taskId: dependentOn });
    }
    
    if (!parentTask) {
      throw new Error(`PARENT REQUIRED: "${dependentOn}" missing`);
    }

    const parentRef = parentTask.plannedDueDate || parentTask.plannedStartDate || fmsStart;
    
    // P-T-P: immediate from parent planned
    if (startTimeSetting === 'planned-to-planned') {
      if (freq.includes('hour')) {
        const shiftStart = await nextWorkingShiftDate(parentRef, workShiftId);
        startDate = new Date(shiftStart.getTime() + (absX * 3600000 * sign));
      } else {
        startDate = await addWorkingDaysHoliday(parentRef, absX * sign, workShiftId);
      }
    } else {
      // A-T-P: null until parent finish
      startDate = null;
    }
  } 
  // ===== NON-DEPENDENT =====
  else {
    // START +/- → fmsStart
    if (freq.includes('start')) {
      if (freq.includes('hour')) {
        const shiftStart = await nextWorkingShiftDate(fmsStart, workShiftId);
        startDate = new Date(shiftStart.getTime() + (absX * 3600000 * sign));
      } else {
        startDate = await addWorkingDaysHoliday(fmsStart, absX * sign, workShiftId);
      }
    } 
    // EVENT +/- → fmsEnd
    else if (freq.includes('event')) {
      if (!fmsEnd) throw new Error('Event needs fmsEnd');
      if (freq.includes('hour')) {
        const shiftStart = await nextWorkingShiftDate(fmsEnd, workShiftId);
        startDate = new Date(shiftStart.getTime() + (absX * 3600000 * sign));
      } else {
        startDate = await addWorkingDaysHoliday(fmsEnd, absX * sign, workShiftId);
      }
    }
    // DEFAULT
    else {
      startDate = await nextWorkingShiftDate(fmsStart, workShiftId);
    }
  }

  // DUE always
  if (taskEndDays > 0 && startDate) {
    dueDate = await addWorkingDaysHoliday(startDate, taskEndDays, workShiftId);
  }

  return { startDate, dueDate };
}

export default { calculateFmsTaskDates };

