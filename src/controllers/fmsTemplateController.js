import FmsTemplate from '../models/FmsTemplate.js';
import FmsTask from '../models/FmsTask.js';
import User from '../models/User.js';
import { handleAsync } from '../utils/handleAsync.js';
import AppError from '../utils/AppError.js';
import { createLog } from './logController.js';

export const createTemplate = handleAsync(async (req, res, next) => {
  const { templateName, description, fmsDuration, endDate, manager, srManager } = req.body;
  const userId =  req.cookies.userId;

  // Check duplicate templateName (Mongo unique will catch but custom msg better)
  const existing = await FmsTemplate.findOne({ templateName });
  if (existing) {
    return next(new AppError(`Template "${templateName}" already exists`, 400));
  }

  // Role validation (BRD)
  const managerUser = await User.findById(manager).populate('role');
  if (!managerUser || managerUser.role.name !== 'Manager') {
    return next(new AppError('Manager must have Manager role', 400));
  }
  if (srManager) {
    const srUser = await User.findById(srManager).populate('role');
    if (!srUser || srUser.role.name !== 'Sr. Manager') {
      return next(new AppError('Sr Manager must have Sr Manager role', 400));
    }
  }

  const template = await FmsTemplate.create({
    templateName,
    description: description || '',
    fmsDuration,
    endDate: fmsDuration === 'Fixed Period' ? endDate : undefined,
    manager: managerUser._id,
    srManager: srManager || undefined,
  });

  await template.populate([
    'manager', 
    'srManager', 
    'taskCount', 
    'instanceCount'
  ]);

  await createLog({
    action: 'CREATE_TEMPLATE',
    module: 'FMS_TEMPLATE',
    performedBy: userId,
    documentId: template._id,
    newData: template,
  });

  res.status(201).json({
    success: true,
    data: template,
  });
});

export const getTemplates = handleAsync(async (req, res) => {
  const { 
    page = 1, 
    limit = 10, 
    search, 
    managerId, 
    fmsDuration 
  } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = {};
  if (search) {
    filter.templateName = { $regex: search, $options: 'i' };
  }
  if (managerId) {
    filter.manager = managerId;
  }
  if (fmsDuration) {
    filter.fmsDuration = fmsDuration;
  }

  const [templates, total] = await Promise.all([
    FmsTemplate.find(filter)
      .populate('manager srManager', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    FmsTemplate.countDocuments(filter)
  ]);

  res.status(200).json({
    success: true,
    data: templates,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit))
    }
  });
});

export const getTemplateById = handleAsync(async (req, res, next) => {
  const template = await FmsTemplate.findById(req.params.id)
    .populate([
      'manager', 
      'srManager', 
      'taskCount', 
      'instanceCount'
    ]);

  if (!template) return next(new AppError('Template not found', 404));

  // Load tasks separately (since one-to-many)
  const tasks = await FmsTask.find({ fmsTemplateId: template._id })
    // .populate('assignedTo departmentOfAssignToUser', 'name email')
    .populate("assignedTo", "name email")
    .populate("departmentOfAssignToUser", "name")
    .populate("assignedBy", "name email")
    .sort('taskId');

  res.json({ 
    success: true, 
    data: { 
      ...template.toObject(), 
      tasks 
    } 
  });
});

export const updateTemplate = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const updateData = req.body;
  const userId =  req.cookies.userId;

  const template = await FmsTemplate.findById(id);
  if (!template) return next(new AppError('Template not found', 404));

  const oldData = template.toObject();

  // Duplicate check (exclude self)
  if (updateData.templateName && updateData.templateName !== template.templateName) {
    const dupe = await FmsTemplate.findOne({ 
      templateName: updateData.templateName,
      _id: { $ne: id }
    });
    if (dupe) {
      return next(new AppError(`Template "${updateData.templateName}" already exists`, 400));
    }
  }

  // Role validation if changed
  if (updateData.manager) {
    const managerUser = await User.findById(updateData.manager).populate('role');
    if (!managerUser || managerUser.role.name !== 'Manager') {
      return next(new AppError('Manager must have Manager role', 400));
    }
  }
  if (updateData.srManager) {
    const srUser = await User.findById(updateData.srManager).populate('role');
    if (!srUser || srUser.role.name !== 'Sr. Manager') {
      return next(new AppError('Sr Manager must have Sr Manager role', 400));
    }
  }

  Object.assign(template, updateData);
  await template.save();

  await template.populate([
    'manager', 
    'srManager', 
    'taskCount', 
    'instanceCount'
  ]);

  await createLog({
    action: 'UPDATE_TEMPLATE',
    module: 'FMS_TEMPLATE',
    performedBy: userId,
    documentId: template._id,
    oldData,
    newData: template,
  });

  res.json({ success: true, data: template });
});

export const deleteTemplate = handleAsync(async (req, res, next) => {
  const { force } = req.query;
  const template = await FmsTemplate.findById(req.params.id);
  if (!template) return next(new AppError('Template not found', 404));

  if (force !== 'true') {
    const taskCount = await FmsTask.countDocuments({ fmsTemplateId: template._id });
    if (taskCount > 0) {
      return next(new AppError(`Cannot delete: ${taskCount} tasks exist. Use ?force=true`, 400));
    }
  }

  await createLog({
    action: 'DELETE_TEMPLATE',
    module: 'FMS_TEMPLATE',
    performedBy:  req.cookies.userId,
    documentId: template._id,
    oldData: template,
  });

  await FmsTemplate.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Template deleted' });
});

export const getTemplateTasks = handleAsync(async (req, res) => {
  const tasks = await FmsTask.find({ fmsTemplateId: req.params.id })
    // .populate('departmentOfAssignToUser assignedTo')
    .populate("assignedTo", "name email")
    .populate("departmentOfAssignToUser", "name")
    .populate("assignedBy", "name email")
    .sort('taskId');
  res.json({ success: true, data: tasks });
});

