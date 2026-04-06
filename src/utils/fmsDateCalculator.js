import { nextWorkingShiftDate, addWorkingDaysHoliday } from './dateCalculator.js';
import FmsTask from '../models/FmsTask.js';
import moment from 'moment';

/**
 * ALL 5 CASES - NO addHours/subHours dependency ✓
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
  
  const freq = frequency?.trim().toLowerCase() || '';
  let startDate = await nextWorkingShiftDate(fmsStart, workShiftId);
  let dueDate;

  // CASE 1: "Anytime"
  if (freq === 'anytime') { /* default */ }
  // CASE 4 DEP
  else if (isDependent && dependentOn) {
    const parentTask = previousTasks.find(t => t.taskId === dependentOn) || await FmsTask.findOne({ taskId: dependentOn });
    if (!parentTask) throw new Error(`DEP ERROR: "${dependentOn}" missing`);
    
    const parentRef = parentTask.plannedDueDate || parentTask.plannedStartDate || fmsStart;
    const shiftBase = await nextWorkingShiftDate(parentRef, workShiftId);
    
    if (startTimeSetting === 'planned-to-planned') {
      if (freq.includes('hour')) {
        dueDate = new Date(shiftBase.getTime() + (Math.abs(xValue) * 3600000 * (xValue >= 0 ? 1 : -1)));
      } else {
        dueDate = await addWorkingDaysHoliday(parentRef, xValue, workShiftId);
      }
    }
  }
  // CASE 2-3 Start
  else if (freq.startsWith('start')) {
    const shiftBase = await nextWorkingShiftDate(fmsStart, workShiftId);
    if (freq.includes('hour')) {
      dueDate = new Date(shiftBase.getTime() + (Math.abs(xValue) * 3600000 * (xValue >= 0 ? 1 : -1)));
    } else {
      dueDate = await addWorkingDaysHoliday(fmsStart, xValue, workShiftId);
    }
  }
  // CASE 5 Event
  else if (freq.startsWith('event') && fmsEnd) {
    const shiftBase = await nextWorkingShiftDate(fmsEnd, workShiftId);
    if (freq.includes('hour')) {
      dueDate = new Date(shiftBase.getTime() + (Math.abs(xValue) * 3600000 * (xValue >= 0 ? 1 : -1)));
    } else {
      dueDate = await addWorkingDaysHoliday(fmsEnd, xValue, workShiftId);
    }
  }

  // taskEndDays OVERRIDE
  if (taskEndDays > 0) {
    dueDate = await addWorkingDaysHoliday(startDate, taskEndDays, workShiftId);
  }

  return { startDate, dueDate };
}

export default { calculateFmsTaskDates };

