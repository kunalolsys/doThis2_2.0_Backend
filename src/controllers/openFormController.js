import OpenForm from "../models/OpenForm.js";
import { handleAsync } from "../utils/handleAsync.js";
import FormSubmission from "../models/FormSubmission.js";
import FmsTemplate from "../models/FmsTemplate.js";
import FmsTask from "../models/FmsTask.js";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import Counter from "../models/Counter.js";
import AppError from "../utils/AppError.js";
import fmsDateCalculator, {
  calculateCalendarDurationWithShiftSnap,
  parseFrequencyToHours,
} from "../utils/fmsDateCalculator.js";
import User from "../models/User.js";
import { generateRecurringFmsTasks } from "../cron/assignRecurringFmsTask.js";
import Role from "../models/Role.js";
import {
  addWorkingDaysHoliday,
  isHoliday,
  isWorkingDay,
  nextWorkingShiftDate,
  snapToShiftTime,
} from "../utils/dateCalculator.js";
import mongoose from 'mongoose'

const generateSlug = (text) => {
  return text
    ?.toLowerCase()
    .trim()
    .replace(/\s+/g, "-") // spaces → -
    .replace(/[^\w-]+/g, ""); // remove special chars
};

//**CREATE OPEN FORM */
export const createOpenForm = handleAsync(async (req, res, next) => {
  const baseUrl = process.env.BASE_URL;
  const { formName, status, linkedTemplate } = req.body;

  const targetStatus = status || "draft";

  // Sanitize empty string to null
  const cleanTemplate =
    linkedTemplate && linkedTemplate.trim() !== "" ? linkedTemplate : null;

  // ⛔ Prevent publishing if linkedTemplate is missing
  if (targetStatus === "published" && !cleanTemplate) {
    return next(
      new AppError("Cannot publish form without linking an FMS template.", 400),
    );
  }

  const existingForm = await OpenForm.findOne({
    formName: formName.trim(),
    isDeleted: false,
  });

  if (existingForm) {
    return next(new AppError(`Open Form "${formName}" already exists`, 400));
  }

  const slug = generateSlug(formName);

  const form = await OpenForm.create({
    ...req.body,
    linkedTemplate: cleanTemplate, // Pass sanitized null value
    slug,
    status: targetStatus,
    formUrl: `${baseUrl}/open-form/${slug}`,
    createdBy: req.cookies.userId || req.user._id,
  });

  res.status(201).json({
    success: true,
    data: form,
  });
});

//**GET ALL FORMS (SUPPORTING TEMPLATE DEPENDENT FILTERING) */
export const getAllOpenForms = handleAsync(async (req, res) => {
  const {
    search,
    isActive,
    role: bodyRole,
    templateId,
    linkedTemplate,
  } = {
    ...req.query,
    ...req.body,
  };

  // Extract userId and role safely
  const userId = req.cookies?.userId || req.user?._id;
  const roleInput = bodyRole || req.user?.role || req.cookies?.role;
  const rawRole = typeof roleInput === "object" ? roleInput?.name : roleInput;
  const userRole = String(rawRole || "").toLowerCase();

  // Base Query: Exclude deleted forms
  const query = { isDeleted: { $ne: true } };

  // =========================
  // 👥 ROLE BASED ACCESS
  // =========================
  if (userRole === "admin" || userRole === "pc") {
    // ✅ ADMIN / PC sees ALL open forms across all users.
  } else if (
    userRole === "sr. manager" ||
    userRole === "srmanager" ||
    userRole === "sr._manager"
  ) {
    // Sr. Manager sees forms created by themselves or Managers
    const managerRole = await Role.findOne({ name: "manager" })
      .select("_id")
      .lean();

    if (managerRole) {
      const managerUsers = await User.find({ role: managerRole._id })
        .select("_id")
        .lean();
      const managerIds = managerUsers.map((u) => u._id);

      query.createdBy = {
        $in: [userId, ...managerIds],
      };
    } else {
      query.createdBy = userId;
    }
  } else {
    // 👤 Regular Users only see their own created forms
    query.createdBy = userId;
  }

  // =========================
  // 🔍 FILTERS
  // =========================

  // Search by form name
  if (search) {
    query.formName = {
      $regex: search,
      $options: "i",
    };
  }

  // Filter active/inactive
  if (isActive !== undefined) {
    query.isActive = isActive === true || isActive === "true";
  }

  // =========================
  // 🎯 TEMPLATE DEPENDENT FILTERING
  // =========================
  const targetTemplate = templateId || linkedTemplate;

  if (
    targetTemplate &&
    targetTemplate !== "all" &&
    mongoose.Types.ObjectId.isValid(targetTemplate)
  ) {
    if (Array.isArray(targetTemplate)) {
      query.linkedTemplate = { $in: targetTemplate };
    } else {
      query.linkedTemplate = new mongoose.Types.ObjectId(targetTemplate);
    }
  }

  // =========================
  // 🚀 DB EXECUTION
  // =========================
  const forms = await OpenForm.find(query)
    .populate("linkedTemplate", "templateName fmsId")
    .populate("createdBy", "name email")
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({
    success: true,
    count: forms.length,
    data: forms,
  });
});

//**GET FORM BY ID */
export const getOpenForm = handleAsync(async (req, res) => {
  const { slug } = req.params;

  const form = await OpenForm.findOne({
    slug,
    isActive: true,
  }).populate("linkedTemplate");

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

//**UPDATE FORM */
export const updateOpenForm = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const {
    formName,
    description,
    linkedTemplate,
    fields,
    isActive,
    allowMultipleSubmissions,
    status,
  } = req.body;

  const form = await OpenForm.findById(id);

  if (!form) {
    return next(new AppError("Open form not found", 404));
  }

  // Sanitize empty string to null
  const cleanTemplate =
    linkedTemplate !== undefined
      ? linkedTemplate && linkedTemplate.trim() !== ""
        ? linkedTemplate
        : null
      : form.linkedTemplate;

  const effectiveStatus = status !== undefined ? status : form.status;

  // ⛔ Prevent publishing if linkedTemplate is missing
  if (effectiveStatus === "published" && !cleanTemplate) {
    return next(
      new AppError("Cannot publish form without linking an FMS template.", 400),
    );
  }

  if (formName !== undefined) form.formName = formName;
  if (description !== undefined) form.description = description;
  form.linkedTemplate = cleanTemplate; // Set sanitized null value
  if (fields !== undefined) form.fields = fields;
  if (isActive !== undefined) form.isActive = isActive;

  if (status !== undefined) {
    form.status = status;
    if (status === "published" && isActive === undefined) {
      form.isActive = true;
    }
  }

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

//**VALIDATE USER DURING FORM USING */
export const verifyOpenFormUser = handleAsync(async (req, res) => {
  const { employeeCode } = req.body;

  if (!employeeCode) {
    throw new AppError("Employee code is required", 400);
  }

  const user = await User.findOne({
    employeeCode: employeeCode,
    isDeleted: false,
    isActive: true,
  }).select("_id name companyCode employeeCode department");

  if (!user) {
    throw new AppError("Invalid employee code", 404);
  }

  res.status(200).json({
    success: true,
    data: user,
  });
});

export const submitOpenForm = handleAsync(async (req, res, next) => {
  const { slug } = req.params;
  const { employeeCode, submissionData } = req.body;
  const employee = await User.findOne({ employeeCode });

  if (!employee) {
    return next(new AppError("Invalid employee code", 400));
  }

  const userId = employee._id;

  // =====================================================
  // 1. GET FORM
  // =====================================================
  const form = await OpenForm.findOne({
    slug,
    isActive: true,
  }).populate("linkedTemplate");

  if (!form) return next(new AppError("Form not found", 404));
  if (!form.isActive) return next(new AppError("Form is inactive", 400));
  if (!form.linkedTemplate)
    return next(new AppError("No template linked with form", 400));

  // =====================================================
  // 2. VALIDATE SUBMISSION DATA
  // =====================================================
  const enrichedSubmissionData = {};
  for (const field of form.fields) {
    enrichedSubmissionData[field.fieldId] = {
      value: submissionData[field.fieldId],
      isTableColumn: field.isTableColumn || false,
      label: field.label,
      fieldType: field.fieldType,
    };
  }

  // =====================================================
  // 3. SAVE FORM SUBMISSION & COUNTER
  // =====================================================
  const submission = await FormSubmission.create({
    formId: form._id,
    submittedBy: userId,
    submissionData: enrichedSubmissionData,
    status: "Submitted",
  });

  const counter = await Counter.findOneAndUpdate(
    { _id: "fms_instance" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );

  const formSubmissionDate = new Date();
  const template = form.linkedTemplate;

  const instanceEnd =
    template.fmsDuration === "Fixed Period" ? template.endDate : null;

  const instanceStatus = calculateInstanceStatus(formSubmissionDate);

  const instance = await FmsInstance.create({
    fmsTemplateId: template._id,
    instanceName: `${template.templateName}`,
    formId: form._id,
    submissionId: submission._id,
    triggerType: "FORM_SUBMISSION",
    startDate: formSubmissionDate,
    endDate: instanceEnd,
    manager: template.manager,
    srManager: template.srManager || null,
    createdBy: userId,
    status: instanceStatus,
    fmsDuration: template.fmsDuration,
    runtimeContext: enrichedSubmissionData,
  });

  // =====================================================
  // 4. FETCH TEMPLATE TASKS
  // =====================================================
  const templateTasks = await FmsTask.find({
    fmsTemplateId: template._id,
  }).sort("taskId");

  if (!templateTasks.length) {
    return next(new AppError("No tasks found in linked template", 400));
  }

  // =====================================================
  // 5. CREATE ALL INSTANCE TASKS AT ONCE
  // =====================================================
  const instanceTasks = [];

  for (let i = 0; i < templateTasks.length; i++) {
    const tmplTask = templateTasks[i];

    const doer = await User.findById(tmplTask.assignedTo).populate(
      "assignShift",
    );
    if (!doer || !doer.assignShift) continue;

    const taskDeptContext =
      tmplTask.departmentOfAssignToUser || doer?.department || doer?._id;

    let dates = { startDate: null, dueDate: null };

    const rawFreq = (tmplTask.frequency || "").trim();
    const freq = rawFreq.toLowerCase();

    // 🟢 CASE A: RECURRING TASKS
    if (RECURRING_FREQUENCIES.includes(rawFreq) || freq === "anytime") {
      let shiftStart = await nextWorkingShiftDate(
        formSubmissionDate,
        doer.assignShift._id,
        {},
        taskDeptContext,
      );

      const shiftEnd = snapToShiftTime(
        formSubmissionDate,
        doer.assignShift,
        false,
      );
      if (formSubmissionDate >= shiftEnd) {
        let nextDay = new Date(formSubmissionDate);
        nextDay.setDate(nextDay.getDate() + 1);

        shiftStart = await nextWorkingShiftDate(
          nextDay,
          doer.assignShift._id,
          {},
          taskDeptContext,
        );
      }

      dates = {
        startDate: snapToShiftTime(shiftStart, doer.assignShift, true),
        dueDate: snapToShiftTime(shiftStart, doer.assignShift, false),
      };
    }
    // 🟢 CASE B: FORM EVENT & START FREQUENCIES (MATCHING PLANNED-TO-PLANNED LOGIC)
    else if (
      tmplTask.linkedWithForm ||
      freq.includes("form event") ||
      freq.includes("event") ||
      freq.startsWith("start")
    ) {
      let taskStartDate = new Date(formSubmissionDate);

      // Same Working Day / Holiday / Shift-End validation as Planned-To-Planned
      const isWorking = await isWorkingDay(
        taskStartDate,
        doer.assignShift,
        taskDeptContext,
      );
      const isHoli = await isHoliday(taskStartDate, taskDeptContext);
      const shiftEnd = snapToShiftTime(taskStartDate, doer.assignShift, false);

      if (!isWorking || isHoli || taskStartDate >= shiftEnd) {
        let nextDay = new Date(taskStartDate);
        if (taskStartDate >= shiftEnd) {
          nextDay.setDate(nextDay.getDate() + 1);
        }

        const nextWorkingShift = await nextWorkingShiftDate(
          nextDay,
          doer.assignShift._id,
          {},
          taskDeptContext,
        );

        taskStartDate = snapToShiftTime(
          nextWorkingShift,
          doer.assignShift,
          true,
        );
      }

      const freqParsed = parseFrequencyToHours(
        tmplTask.frequency,
        tmplTask.xValue,
      );

      const dueDate = await calculateCalendarDurationWithShiftSnap(
        taskStartDate,
        freqParsed,
        doer.assignShift._id,
        taskDeptContext,
      );

      dates = {
        startDate: taskStartDate,
        dueDate,
      };
    }
    // 🟢 CASE C: DEPENDENT TASKS (PLANNED-TO-PLANNED) - UNTOUCHED
    else if (tmplTask.isDependent && tmplTask.dependentOn) {
      if (tmplTask.startTimeSetting === "planned-to-planned") {
        const parentTask = instanceTasks.find(
          (t) => t.originalTaskId === tmplTask.dependentOn,
        );

        let taskStartDate = parentTask
          ? new Date(parentTask.plannedDueDate)
          : new Date(formSubmissionDate);

        const isParentWorkingDay = await isWorkingDay(
          taskStartDate,
          doer.assignShift,
          taskDeptContext,
        );
        const isParentHoli = await isHoliday(taskStartDate, taskDeptContext);
        const shiftEnd = snapToShiftTime(
          taskStartDate,
          doer.assignShift,
          false,
        );

        if (!isParentWorkingDay || isParentHoli || taskStartDate >= shiftEnd) {
          let nextDay = new Date(taskStartDate);
          if (taskStartDate >= shiftEnd) {
            nextDay.setDate(nextDay.getDate() + 1);
          }

          const nextWorkingShift = await nextWorkingShiftDate(
            nextDay,
            doer.assignShift._id,
            {},
            taskDeptContext,
          );

          taskStartDate = snapToShiftTime(
            nextWorkingShift,
            doer.assignShift,
            true,
          );
        }

        const freqParsed = parseFrequencyToHours(
          tmplTask.frequency,
          tmplTask.xValue,
        );

        const dueDate = await calculateCalendarDurationWithShiftSnap(
          taskStartDate,
          freqParsed,
          doer.assignShift._id,
          taskDeptContext,
        );

        dates = {
          startDate: taskStartDate,
          dueDate,
        };
      } else {
        dates = { startDate: null, dueDate: null };
      }
    }
    // 🟢 CASE D: FALLBACK DATES - UNTOUCHED
    else {
      const previousTasks = instanceTasks.map((task) => ({
        taskId: task.originalTaskId,
        plannedDueDate: task.plannedDueDate,
        plannedStartDate: task.plannedStartDate,
      }));

      dates = await fmsDateCalculator.calculateFmsTaskDates(
        tmplTask.toObject(),
        formSubmissionDate,
        instanceEnd,
        doer.assignShift?._id,
        previousTasks,
        taskDeptContext,
      );
    }

    const runtimeTaskId = `${instance.instanceId}-${tmplTask.taskId}`;
    const isDecisionStep =
      tmplTask.decisionStep === true ||
      tmplTask.decisionStep === "yes" ||
      tmplTask.decisionStep === "true";

    const instanceTaskData = {
      fmsInstanceId: instance._id,
      fmsTaskId: tmplTask._id,
      formId: form._id,
      submissionId: submission._id,
      submissionData: enrichedSubmissionData,

      taskId: runtimeTaskId,
      originalTaskId: tmplTask.taskId,

      description: tmplTask.description,
      departmentOfAssignToUser: tmplTask.departmentOfAssignToUser,
      assignedTo: tmplTask.assignedTo,
      assignedBy: tmplTask.assignedBy,

      frequency: tmplTask.frequency,
      linkedWithForm: Boolean(tmplTask.linkedWithForm),
      xValue: tmplTask.xValue,

      isDependent: tmplTask.isDependent,
      dependentOn: tmplTask.dependentOn
        ? `${instance.instanceId}-${tmplTask.dependentOn}`
        : null,

      startTimeSetting: tmplTask.startTimeSetting,
      taskEndDays: tmplTask.taskEndDays || 0,

      plannedStartDate: dates.startDate,
      plannedDueDate: dates.dueDate,

      status: calculateTaskStatus(dates.startDate, dates.dueDate),
      isVisible: false,
      waitingForParent: tmplTask.startTimeSetting === "actual-to-planned",

      decisionStep: isDecisionStep,
      decisionYesAction: isDecisionStep
        ? tmplTask.decisionYesAction || null
        : null,
      triggerFmsTemplate:
        isDecisionStep && tmplTask.decisionYesAction === "trigger_fms"
          ? tmplTask.triggerFmsTemplate || null
          : null,

      checklist: tmplTask.checklist || [],
      createdForm: tmplTask.createdForm || [],

      createdBy: userId,
      updatedBy: userId,
    };

    const instanceTask = await FmsInstanceTask.create(instanceTaskData);
    instanceTasks.push(instanceTask);
  }

  submission.triggeredInstance = instance._id;
  submission.status = "Triggered";
  await submission.save();

  return res.status(201).json({
    success: true,
    message:
      "Form submitted and FMS triggered successfully with all tasks generated.",
    data: {
      formId: form._id,
      submissionId: submission._id,
      templateId: template._id,
      instanceId: instance._id,
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
//**GET SUBMISSION RESPONSE AND RECORD (TEMPLATE & FORM CASCADED) */
export const getFormSubmissions = async (req, res) => {
  try {
    const { formId: paramFormId } = req.params;
    const {
      formId: queryFormId,
      templateId,
      linkedTemplate,
      search,
      status,
      startDate,
      endDate,
    } = {
      ...req.query,
      ...req.body,
    };

    // Ignore placeholder strings like "submissions" or "all"
    const activeFormId =
      paramFormId && paramFormId !== "submissions" && paramFormId !== "all"
        ? paramFormId
        : queryFormId && queryFormId !== "all"
          ? queryFormId
          : null;

    const activeTemplateId =
      templateId && templateId !== "all"
        ? templateId
        : linkedTemplate && linkedTemplate !== "all"
          ? linkedTemplate
          : null;

    const query = {};

    // ==========================================
    // 🎯 1. TEMPLATE BASED CASCADE FILTERING
    // ==========================================
    if (activeTemplateId && mongoose.Types.ObjectId.isValid(activeTemplateId)) {
      // Find all active forms linked to this FMS Template
      const templateForms = await OpenForm.find({
        linkedTemplate: new mongoose.Types.ObjectId(activeTemplateId),
        isDeleted: { $ne: true },
      })
        .select("_id")
        .lean();

      const formIds = templateForms.map((f) => f._id);

      if (activeFormId && mongoose.Types.ObjectId.isValid(activeFormId)) {
        // If specific form selected, check if it belongs to template forms
        const isLinked = formIds.some(
          (id) => id.toString() === String(activeFormId),
        );
        query.formId = isLinked
          ? new mongoose.Types.ObjectId(activeFormId)
          : null;
      } else {
        // Fetch submissions for all forms under this template
        query.formId = { $in: formIds };
      }
    } else if (activeFormId && mongoose.Types.ObjectId.isValid(activeFormId)) {
      query.formId = new mongoose.Types.ObjectId(activeFormId);
    }

    // ==========================================
    // 🎯 2. STATUS FILTERING ("Submitted", "Triggered", "Failed")
    // ==========================================
    if (status && status !== "all") {
      query.status = status;
    }

    // ==========================================
    // 🎯 3. DATE RANGE FILTERING
    // ==========================================
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // ==========================================
    // 🎯 4. SEARCH FILTERING (Submitter Name / Code)
    // ==========================================
    if (search && String(search).trim() !== "") {
      const searchRegex = new RegExp(String(search).trim(), "i");

      const matchingUsers = await User.find({
        $or: [{ name: searchRegex }, { employeeCode: searchRegex }],
      })
        .select("_id")
        .lean();

      const userIds = matchingUsers.map((u) => u._id);

      query.$or = [{ submittedBy: { $in: userIds } }];
    }

    // ==========================================
    // 🚀 DB EXECUTION
    // ==========================================
    const submissions = await FormSubmission.find(query)
      .populate({
        path: "formId",
        select: "formName slug linkedTemplate fields",
        populate: {
          path: "linkedTemplate",
          select: "templateName fmsId fmsDuration",
        },
      })
      .populate("submittedBy", "name employeeCode email")
      .populate("triggeredInstance", "instanceId status")
      .sort({ createdAt: -1 })
      .lean();

    // Map parentFormName for smooth table rendering
    const formattedSubmissions = submissions.map((sub) => ({
      ...sub,
      parentFormName: sub.formId?.formName || "Unnamed Form",
      parentFormId: sub.formId?._id || sub.formId,
      linkedTemplateId:
        sub.formId?.linkedTemplate?._id || sub.formId?.linkedTemplate || null,
    }));

    return res.status(200).json({
      success: true,
      count: formattedSubmissions.length,
      data: formattedSubmissions,
    });
  } catch (error) {
    console.error("Error in getFormSubmissions:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch form submissions",
      data: [],
    });
  }
};

export const getSubmissionDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const submission = await FormSubmission.findById(id)
      .populate("submittedBy", "name employeeCode email")
      .populate("formId")
      .populate("triggeredInstance");

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: "Submission not found",
      });
    }

    res.status(200).json({
      success: true,
      data: submission,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

//**DELETE OPEN FORM */
export const deleteOpenForm = handleAsync(async (req, res) => {
  const { formId } = req.params;

  const form = await OpenForm.findOne({
    _id: formId,
    isDeleted: false,
  });

  if (!form) {
    return res.status(404).json({
      success: false,
      message: "Open form not found",
    });
  }

  form.isDeleted = true;
  form.deletedAt = new Date();
  form.deletedBy = req.cookies.userId || req.user?._id || null;

  await form.save();

  res.status(200).json({
    success: true,
    message: "Open form deleted successfully",
  });
});
