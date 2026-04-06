import FmsInstance from '../models/FmsInstance.js';
import FmsInstanceTask from '../models/FmsInstanceTask.js';
import FmsTemplate from '../models/FmsTemplate.js';
import FmsTask from '../models/FmsTask.js';
import User from '../models/User.js';
import { handleAsync } from '../utils/handleAsync.js';
import AppError from '../utils/AppError.js';
import { createLog } from './logController.js';

export const launchFmsInstance = handleAsync(async (req, res, next) => {
  const { templateId } = req.params;
  const { startDate: launchDateStr, overrides = {} } = req.body; // overrides {taskId: {doer: ID}}
  
  const template = await FmsTemplate.findById(templateId).populate([
    'manager', 'srManager', { path: 'tasks', populate: ['assignedTo', 'departmentOfAssignToUser'] }
  ]);
  if (!template) return next(new AppError('Template not found', 404));

  const launchDate = new Date(launchDateStr || Date.now());

  // Instance
  const instance = await FmsInstance.create({
    fmsTemplateId: template._id,
    instanceName: `${template.templateName} (${launchDate.toLocaleDateString()})`,
    startDate: launchDate,
    endDate: template.endDate,
    manager: template.manager._id,
    srManager: template.srManager?._id,
    createdBy: req.user._id,
  });

  // Clone Tasks to Runtime
  const instanceTasks = [];
  for (const tmplTask of template.tasks) {
    const runtimeTask = new FmsInstanceTask({
      fmsInstanceId: instance._id,
      fmsTaskId: tmplTask._id,
      taskId: tmplTask.taskId,
      description: tmplTask.description,
      departmentOfAssignToUser: tmplTask.departmentOfAssignToUser,
      assignedTo: overrides[tmplTask.taskId]?.doer || tmplTask.assignedTo,
      frequency: tmplTask.frequency,
      xValue: tmplTask.xValue,
      isDependent: tmplTask.isDependent,
      dependentOn: tmplTask.dependentOn,
      startTimeSetting: tmplTask.startTimeSetting,
      decisionStep: tmplTask.decisionStep,
      ifTrueStep: tmplTask.ifTrueStep,
      elseStep: tmplTask.elseStep,
      startDate: tmplTask.startDate,
      dueDate: tmplTask.dueDate,
      status: 'Upcoming',
      waitingForParent: tmplTask.waitingForParent,
    });
    await runtimeTask.save();
    instanceTasks.push(runtimeTask);
  }

  await instance.populate('manager srManager');
  await createLog({ action: 'LAUNCH_FMS', documentId: instance._id, newData: instance });

  res.status(201).json({
    success: true,
    data: { instance, instanceTasks }
  });
});

export const getFmsInstances = handleAsync(async (req, res) => {
  const { status, manager } = req.query;
  const filter = status ? { status } : {};
  if (manager) filter.manager = manager;

  const instances = await FmsInstance.find(filter)
    .populate('fmsTemplateId manager srManager', 'templateName name fmsId')
    .sort({ startDate: -1 });
  res.json({ success: true, data: instances });
});

export const getFmsInstanceById = handleAsync(async (req, res, next) => {
  const instance = await FmsInstance.findById(req.params.id)
    .populate({
      path: 'tasks',
      match: { isDeleted: { $ne: true } },
      populate: ['assignedTo', 'departmentOfAssignToUser']
    })
    .populate('manager srManager fmsTemplateId');
  
  if (!instance) return next(new AppError('FMS Instance not found', 404));
  res.json({ success: true, data: instance });
});

