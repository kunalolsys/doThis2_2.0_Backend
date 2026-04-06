import FmsTemplate from '../models/FmsTemplate.js';
import User from '../models/User.js';
import { handleAsync } from '../utils/handleAsync.js';
import AppError from '../utils/AppError.js';
import { createLog } from './logController.js';

export const createTemplate = handleAsync(async (req, res, next) => {
  const { templateName, description, fmsDuration, endDate, manager, srManager } = req.body;
  const userId = req.user._id;

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

  await template.populate(['manager', 'srManager']);

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
  const templates = await FmsTemplate.find()
    .populate('manager srManager', 'name email')
    .sort({ createdAt: -1 });
  res.status(200).json({
    success: true,
    data: templates,
  });
});

export const getTemplateById = handleAsync(async (req, res, next) => {
  const template = await FmsTemplate.findById(req.params.id)
    .populate({
      path: 'tasks',
      populate: { path: 'assignedTo departmentOfAssignToUser' }
    })
    .populate('manager srManager');
  if (!template) return next(new AppError('Template not found', 404));
  res.json({ success: true, data: template });
});

export const deleteTemplate = handleAsync(async (req, res, next) => {
  const template = await FmsTemplate.findByIdAndDelete(req.params.id);
  if (!template) return next(new AppError('Template not found', 404));
  res.json({ success: true, message: 'Template deleted' });
});

