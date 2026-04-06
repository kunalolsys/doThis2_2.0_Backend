import FmsInstance from '../models/FmsInstance.js';
import FmsInstanceTask from '../models/FmsInstanceTask.js';
import FmsTemplate from '../models/FmsTemplate.js';
import FmsTask from '../models/FmsTask.js';
import User from '../models/User.js';
import { handleAsync } from '../utils/handleAsync.js';
import AppError from '../utils/AppError.js';
import fmsDateCalculator from '../utils/fmsDateCalculator.js';

export const launchFmsInstance = handleAsync(async (req, res, next) => {
  const { templateId } = req.params;
  const { launchDate: launchDateStr } = req.body;
  
  const userId =  req.cookies.userId
  const template = await FmsTemplate.findById(templateId).populate(['manager', 'srManager']);
  if (!template) return next(new AppError('Template not found', 404));

  const launchDate = new Date(launchDateStr || Date.now());
  const instanceEnd = template.fmsDuration === 'Fixed Period' ? template.endDate : null;

  // Create instance
  const instance = await FmsInstance.create({
    fmsTemplateId: template._id,
    instanceName: `${template.templateName} (${launchDate.toLocaleDateString()})`,
    startDate: launchDate,
    endDate: instanceEnd,
    manager: template.manager._id,
    srManager: template.srManager?._id || null,
    createdBy: userId
  });

  // Get template tasks IN ORDER
  const templateTasks = await FmsTask.find({ fmsTemplateId: templateId }).sort('taskId');
  const instanceTasks = [];

  console.log('🚀 LAUNCHING FMS with', templateTasks.length, 'tasks');

  for (let i = 0; i < templateTasks.length; i++) {
    const tmplTask = templateTasks[i];
    const prevTasks = instanceTasks.slice(0, i);
    
    console.log(`${i+1}. ${tmplTask.taskId}: ${tmplTask.frequency} x=${tmplTask.xValue} dep=${tmplTask.dependentOn}`);

    // Get doer
    const doer = await User.findById(tmplTask.assignedTo).populate('assignShift');
    
    const dates = await fmsDateCalculator.calculateFmsTaskDates(
      tmplTask.toObject(),
      launchDate,
      instanceEnd,
      doer.assignShift?._id,
      prevTasks.map(t => ({ taskId: t.taskId, plannedDueDate: t.plannedDueDate, plannedStartDate: t.plannedStartDate }))
    );

    const instanceTaskData = {
      fmsInstanceId: instance._id,
      fmsTaskId: tmplTask._id,
      taskId: tmplTask.taskId,
      description: tmplTask.description,
      departmentOfAssignToUser: tmplTask.departmentOfAssignToUser,
      assignedTo: tmplTask.assignedTo,
      frequency: tmplTask.frequency,
      xValue: tmplTask.xValue,
      isDependent: tmplTask.isDependent,
      dependentOn: tmplTask.dependentOn,
      startTimeSetting: tmplTask.startTimeSetting,
      decisionStep: tmplTask.decisionStep,
      ifTrueStep: tmplTask.ifTrueStep,
      elseStep: tmplTask.elseStep,
      taskEndDays: tmplTask.taskEndDays || 0,
      plannedStartDate: dates.startDate,
      plannedDueDate: dates.dueDate,
      status: calculateTaskStatus(dates.startDate, dates.dueDate),
      isVisible: false, // Cron taskVisibilityCron.js handles
      updatedBy: userId
    };

    const instanceTask = new FmsInstanceTask(instanceTaskData);
    await instanceTask.save();
    instanceTasks.push(instanceTask);
    
    console.log(`✅ ${instanceTask.taskId} → start=${dates.startDate?.toISOString()} due=${dates.dueDate?.toISOString()}`);
  }

  await instance.populate(['manager', 'srManager', 'fmsTemplateId']);

  // FIXED LOG - use valid enum
  // await createLog({
  //   action: 'CREATE',
  //   module: 'FMS_INSTANCE',
  //   performedBy: userId,
  //   documentId: instance._id,
  //   newData: { 
  //     instanceId: instance.instanceId,
  //     taskCount: instanceTasks.length 
  //   },
  //   message: `Launched FMS ${instance.instanceId} with ${instanceTasks.length} tasks`
  // });

  res.status(201).json({
    success: true,
    data: instance,
    tasks: instanceTasks.map(t => ({
      taskId: t.taskId,
      plannedStartDate: t.plannedStartDate,
      plannedDueDate: t.plannedDueDate,
      status: t.status
    }))
  });
});

export const getFmsInstances = handleAsync(async (req, res) => {
  const instances = await FmsInstance.find()
    .populate('fmsTemplateId manager srManager createdBy', 'templateName fmsId name')
    .sort({ startDate: -1 });
  res.json({ success: true, data: instances });
});

export const getFmsInstanceById = handleAsync(async (req, res, next) => {
  const instance = await FmsInstance.findById(req.params.id)
    .populate({
      path: 'tasks',
      populate: ['assignedTo', 'departmentOfAssignToUser', 'fmsTaskId']
    })
    .populate('manager srManager fmsTemplateId createdBy');
  if (!instance) return next(new AppError('Instance not found', 404));
  res.json({ success: true, data: instance });
});

export const getInstanceTasks = handleAsync(async (req, res) => {
  const tasks = await FmsInstanceTask.find({ fmsInstanceId: req.params.id })
    .populate('fmsInstanceId fmsTaskId assignedTo departmentOfAssignToUser updatedBy')
    .sort('taskId');
  res.json({ success: true, data: tasks });
});

const calculateTaskStatus = (startDate, dueDate) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  if (!startDate) return 'Upcoming';
  const s = new Date(startDate);
  if (s > today) return 'Upcoming';
  
  if (dueDate) {
    const d = new Date(dueDate);
    if (d < today) return 'Overdue';
    if (d.toDateString() === today.toDateString()) return 'Delayed';
  }
  return 'Pending';
};

