import FmsTask from '../models/FmsTask.js';
import FmsTemplate from '../models/FmsTemplate.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import { handleAsync } from '../utils/handleAsync.js';
import AppError from '../utils/AppError.js';
import { createLog } from './logController.js';
import { nextWorkingShiftDate, addWorkingDaysHoliday } from '../utils/dateCalculator.js';

const calculateTaskStatus = (startDate, dueDate) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!startDate) return 'Upcoming';
  const s = new Date(startDate);
  if (s > today) return 'Upcoming';
  
  if (dueDate) {
    const d = new Date(dueDate);
    if (d < today) return 'Overdue';
    if (d.getTime() === today.getTime()) return 'Delayed';
  }
  return 'Pending';
};

export const createFmsTasks = handleAsync(async (req, res, next) => {
  const { id: templateId } = req.params;
  let rows = Array.isArray(req.body) ? req.body : [req.body];

  const template = await FmsTemplate.findById(templateId);
  if (!template) return next(new AppError('Template not found', 404));

  const fmsStart = new Date();
  const fmsEnd = template.fmsDuration === 'Fixed Period' ? template.endDate : null;
  const created = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const taskData = {
        fmsTemplateId: template._id,
        description: row.taskDescription,
        departmentOfAssignToUser: row.department,
        assignedTo: row.doer,
        frequency: row.frequency,
        xValue: parseFloat(row.value || 0),
        isDependent: row['is it dependent?'] === 'Yes',
        dependentOn: row['dependent on'],
        startTimeSetting: row['start time setting'],
        decisionStep: row['decision step?'] === 'Yes',
        ifTrueStep: row['if true -> step'],
        elseStep: row['else -> step'],
        taskEndDays: parseFloat(row.taskEndDays || 0),
        assignedBy: req.user._id,
        createdBy: req.user._id,
      };

      // Validation
      if (!taskData.description || !taskData.departmentOfAssignToUser || !taskData.assignedTo || !taskData.frequency) {
        throw new Error('Missing required fields');
      }

      const dept = await Department.findById(taskData.departmentOfAssignToUser);
      if (!dept) throw new Error('Invalid department');

      const doer = await User.findById(taskData.assignedTo).populate('role assignShift');
      if (!doer || doer.role.name !== 'Member' || !doer.assignShift) {
        throw new Error('Doer must be Member with shift');
      }

      if (taskData.isDependent && !taskData.dependentOn) {
        throw new Error('Dependent On required');
      }

      const workShift = doer.assignShift._id;

      // Scheduling Logic
      let startDate, dueDate, waitingForParent = false;

      if (taskData.isDependent) {
        const parentTask = [...created, ...await FmsTask.find({ fmsTemplateId })].find(t => t.taskId === taskData.dependentOn);
        if (!parentTask) throw new Error('Parent task not found');

        const x = taskData.xValue;
        if (taskData.startTimeSetting === 'planned-to-planned') {
          startDate = await addWorkingDaysHoliday(parentTask.dueDate || parentTask.startDate, x, workShift);
        } else {
          waitingForParent = true;
        }
      } else {
        startDate = await nextWorkingShiftDate(fmsStart, workShift);
        if (taskData.frequency.startsWith('D+') || taskData.frequency.startsWith('Start+')) {
          const x = taskData.xValue;
          startDate = await addWorkingDaysHoliday(startDate, x, workShift);
        } else if (taskData.frequency.startsWith('Event')) {
          startDate = await addWorkingDaysHoliday(fmsEnd, taskData.xValue, workShift);
        }
      }

      dueDate = taskData.taskEndDays > 0 ? await addWorkingDaysHoliday(startDate, taskData.taskEndDays, workShift) : null;

      const task = new FmsTask({
        ...taskData,
        startDate,
        dueDate,
        waitingForParent,
        status: calculateTaskStatus(startDate, dueDate),
      });

      await task.save();
      await task.populate(['departmentOfAssignToUser', 'assignedTo']);
      created.push(task);

    } catch (err) {
      errors.push({ row: i + 1, error: err.message });
    }
  }

  res.json({
    success: true,
    created: created.length,
    errors,
    data: created,
  });
});

export const getFmsTasksByTemplate = handleAsync(async (req, res) => {
  const tasks = await FmsTask.find({ fmsTemplateId: req.params.id })
    .populate('departmentOfAssignToUser assignedTo')
    .sort('taskId');
  res.json({ success: true, data: tasks });
});

