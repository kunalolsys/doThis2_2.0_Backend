import OpenForm from "../models/OpenForm.js";
import { handleAsync } from "../utils/handleAsync.js";
import FormSubmission from "../models/FormSubmission.js";
import FmsTemplate from "../models/FmsTemplate.js";
import FmsTask from "../models/FmsTask.js";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import Counter from "../models/Counter.js";
import AppError from "../utils/AppError.js";
import fmsDateCalculator from "../utils/fmsDateCalculator.js";
import User from "../models/User.js";
export const createOpenForm = handleAsync(async (req, res) => {
  const form = await OpenForm.create({
    ...req.body,
    createdBy: req.cookies.userId || req.user._id,
  });

  res.status(201).json({
    success: true,
    data: form,
  });
});
export const getAllOpenForms = handleAsync(async (req, res) => {
  const { search, isActive } = req.query;

  const query = {};

  // Search by form name
  if (search) {
    query.formName = {
      $regex: search,
      $options: "i",
    };
  }

  // Filter active/inactive
  if (isActive !== undefined) {
    query.isActive = isActive === "true";
  }

  const forms = await OpenForm.find(query)
    .populate("linkedTemplate", "templateName fmsId")
    .populate("createdBy", "name email")
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    count: forms.length,
    data: forms,
  });
});
export const getOpenForm = handleAsync(async (req, res) => {
  const form = await OpenForm.findById(req.params.id).populate(
    "linkedTemplate",
  );

  res.json({
    success: true,
    data: form,
  });
});

const RECURRING_FREQUENCIES = ["Daily", "Weekly", "Monthly", "Anytime"];

const calculateInstanceStatus = (startDate) => {
  const now = new Date();

  if (startDate && now < startDate) {
    return "Upcoming";
  }

  return "Ongoing";
};

const calculateTaskStatus = (startDate, dueDate) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!startDate) return "Upcoming";

  const s = new Date(startDate);

  if (s > today) return "Upcoming";

  if (dueDate) {
    const d = new Date(dueDate);

    if (d < today) return "Overdue";

    if (d.toDateString() === today.toDateString()) {
      return "Delayed";
    }
  }

  return "Pending";
};
export const updateOpenForm = handleAsync(async (req, res, next) => {
  const { id } = req.body;
  const {
    formName,
    description,
    linkedTemplate,
    fields,
    isActive,
    allowMultipleSubmissions,
  } = req.body;

  const form = await OpenForm.findById(id);

  if (!form) {
    return next(new AppError("Open form not found", 404));
  }

  // Dynamic updates
  if (formName !== undefined) form.formName = formName;
  if (description !== undefined) form.description = description;
  if (linkedTemplate !== undefined) form.linkedTemplate = linkedTemplate;
  if (fields !== undefined) form.fields = fields;
  if (isActive !== undefined) form.isActive = isActive;

  if (allowMultipleSubmissions !== undefined) {
    form.allowMultipleSubmissions = allowMultipleSubmissions;
  }

  await form.save();

  await form.populate([
    {
      path: "linkedTemplate",
      select: "templateName fmsId",
    },
    {
      path: "createdBy",
      select: "name email",
    },
  ]);

  res.status(200).json({
    success: true,
    message: "Open form updated successfully",
    data: form,
  });
});
export const submitOpenForm = handleAsync(async (req, res, next) => {
  const userId = req.cookies.userId || req.user?._id || null;

  // =====================================================
  // 1. GET FORM
  // =====================================================

  const form = await OpenForm.findById(req.params.id).populate(
    "linkedTemplate",
  );

  if (!form) {
    return next(new AppError("Form not found", 404));
  }

  if (!form.isActive) {
    return next(new AppError("Form is inactive", 400));
  }

  if (!form.linkedTemplate) {
    return next(new AppError("No template linked with form", 400));
  }

  // =====================================================
  // 2. VALIDATE SUBMISSION DATA
  // =====================================================

  const submissionData = req.body || {};

  for (const field of form.fields || []) {
    const value = submissionData[field.fieldId];

    // REQUIRED VALIDATION
    if (field.isRequired) {
      if (value === undefined || value === null || value === "") {
        return next(new AppError(`${field.label} is required`, 400));
      }
    }

    // TYPE VALIDATION
    if (value !== undefined && value !== null && value !== "") {
      switch (field.fieldType) {
        case "email":
          if (!/^\S+@\S+\.\S+$/.test(value)) {
            return next(
              new AppError(`${field.label} must be valid email`, 400),
            );
          }
          break;

        case "number":
          if (isNaN(value)) {
            return next(new AppError(`${field.label} must be number`, 400));
          }
          break;

        case "url":
          try {
            new URL(value);
          } catch {
            return next(new AppError(`${field.label} must be valid URL`, 400));
          }
          break;

        default:
          break;
      }
    }
  }

  // =====================================================
  // 3. SAVE FORM SUBMISSION
  // =====================================================

  const submission = await FormSubmission.create({
    formId: form._id,
    submittedBy: userId,
    submissionData,
    status: "Submitted",
  });

  // =====================================================
  // 4. GENERATE INSTANCE CODE
  // =====================================================

  const counter = await Counter.findOneAndUpdate(
    {
      _id: "fms_instance",
    },
    {
      $inc: {
        seq: 1,
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  const sequence = String(counter.seq).padStart(5, "0");

  // const instanceCode =
  //   `FMS-${new Date().getFullYear()}-${sequence}`;

  // =====================================================
  // 5. CREATE FMS INSTANCE
  // =====================================================

  const launchDate = new Date();

  const template = form.linkedTemplate;

  const instanceEnd =
    template.fmsDuration === "Fixed Period" ? template.endDate : null;

  const instanceStatus = calculateInstanceStatus(launchDate);

  const instance = await FmsInstance.create({
    fmsTemplateId: template._id,

    //   instanceCode,

    instanceName: `${template.templateName}`,

    formId: form._id,

    submissionId: submission._id,

    triggerType: "FORM_SUBMISSION",

    startDate: launchDate,

    endDate: instanceEnd,

    manager: template.manager,

    srManager: template.srManager || null,

    createdBy: userId,

    status: instanceStatus,

    fmsDuration: template.fmsDuration,

    runtimeContext: submissionData,
  });

  // =====================================================
  // 6. FETCH TEMPLATE TASKS
  // =====================================================

  const templateTasks = await FmsTask.find({
    fmsTemplateId: template._id,
  }).sort("taskId");

  if (!templateTasks.length) {
    return next(new AppError("No tasks found in linked template", 400));
  }

  // =====================================================
  // 7. CREATE INSTANCE TASKS
  // =====================================================

  const instanceTasks = [];

  for (let i = 0; i < templateTasks.length; i++) {
    const tmplTask = templateTasks[i];

    // ==========================================
    // SKIP RECURRING TASKS
    // CRON WILL HANDLE THEM
    // ==========================================

    if (RECURRING_FREQUENCIES.includes(tmplTask.frequency)) {
      continue;
    }

    // ==========================================
    // GET USER SHIFT
    // ==========================================

    const doer = await User.findById(tmplTask.assignedTo).populate(
      "assignShift",
    );

    if (!doer || !doer.assignShift) {
      continue;
    }

    // ==========================================
    // CALCULATE DATES
    // ==========================================

    const previousTasks = instanceTasks.map((task) => ({
      taskId: task.originalTaskId,
      plannedDueDate: task.plannedDueDate,
      plannedStartDate: task.plannedStartDate,
    }));

    const dates = await fmsDateCalculator.calculateFmsTaskDates(
      tmplTask.toObject(),
      launchDate,
      instanceEnd,
      doer.assignShift?._id,
      previousTasks,
    );

    // ==========================================
    // UNIQUE RUNTIME TASK ID
    // ==========================================

    const runtimeTaskId = `${instance.instanceId}-${tmplTask.taskId}`;

    // ==========================================
    // CREATE INSTANCE TASK
    // ==========================================

    const instanceTaskData = {
      // LINKS
      fmsInstanceId: instance._id,

      fmsTaskId: tmplTask._id,

      formId: form._id,

      submissionId: submission._id,

      //   instanceCode,

      // TASK IDS
      taskId: runtimeTaskId,

      originalTaskId: tmplTask.taskId,

      // TASK DATA
      description: tmplTask.description,

      departmentOfAssignToUser: tmplTask.departmentOfAssignToUser,

      assignedTo: tmplTask.assignedTo,

      assignedBy: tmplTask.assignedBy,

      frequency: tmplTask.frequency,

      xValue: tmplTask.xValue,

      isDependent: tmplTask.isDependent,

      dependentOn: tmplTask.dependentOn
        ? `${instance.instanceId}-${tmplTask.dependentOn}`
        : null,

      startTimeSetting: tmplTask.startTimeSetting,

      decisionStep: tmplTask.decisionStep,

      ifTrueStep: tmplTask.ifTrueStep
        ? `${instance.instanceId}-${tmplTask.ifTrueStep}`
        : null,

      elseStep: tmplTask.elseStep
        ? `${instance.instanceId}-${tmplTask.elseStep}`
        : null,

      taskEndDays: tmplTask.taskEndDays || 0,

      // DATES
      plannedStartDate: dates.startDate,

      plannedDueDate: dates.dueDate,

      // STATUS
      status: calculateTaskStatus(dates.startDate, dates.dueDate),

      isVisible: false,

      waitingForParent: tmplTask.startTimeSetting === "actual-to-planned",

      // FORMS
      checklist: tmplTask.checklist || [],

      createdForm: tmplTask.createdForm || [],

      // AUDIT
      createdBy: userId,

      updatedBy: userId,
    };

    const instanceTask = await FmsInstanceTask.create(instanceTaskData);

    instanceTasks.push(instanceTask);
  }

  // =====================================================
  // 8. LINK SUBMISSION WITH INSTANCE
  // =====================================================

  submission.triggeredInstance = instance._id;

  submission.status = "Triggered";

  await submission.save();

  // =====================================================
  // 9. FINAL RESPONSE
  // =====================================================

  return res.status(201).json({
    success: true,

    message: "Form submitted and FMS triggered successfully",

    data: {
      formId: form._id,

      submissionId: submission._id,

      templateId: template._id,

      instanceId: instance._id,

      //   instanceCode,

      totalTasks: instanceTasks.length,

      tasks: instanceTasks.map((task) => ({
        taskId: task.taskId,

        originalTaskId: task.originalTaskId,

        status: task.status,

        plannedStartDate: task.plannedStartDate,

        plannedDueDate: task.plannedDueDate,
      })),
    },
  });
});
