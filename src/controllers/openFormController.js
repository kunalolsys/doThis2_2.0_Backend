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
import { generateRecurringFmsTasks } from "../cron/assignRecurringFmsTask.js";
import Role from "../models/Role.js";
import {
  addWorkingDaysHoliday,
  nextWorkingShiftDate,
  snapToShiftTime,
} from "../utils/dateCalculator.js";

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

//**GET ALL FORMS */
export const getAllOpenForms = handleAsync(async (req, res) => {
  const { search, isActive, role: bodyRole } = req.body;

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
    // No query.createdBy filter needed.
  } else if (userRole === "sr. manager" || userRole === "srmanager") {
    // Sr. Manager sees forms created by themselves or Managers
    const managerRole = await Role.findOne({ name: "Manager" })
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

//**SUBMIT OPEN FORM & TRIGGER INSTANCE */
export const submitOpenForm = handleAsync(async (req, res, next) => {
  const { slug } = req.params;
  const { employeeCode, submissionData } = req.body;
  const employee = await User.findOne({ employeeCode });

  if (!employee) {
    return next(new AppError("Invalid employee code", 400));
  }

  // VERIFIED EMPLOYEE ID
  const userId = employee._id;

  // =====================================================
  // 1. GET FORM
  // =====================================================
  const form = await OpenForm.findOne({
    slug,
    isActive: true,
  }).populate("linkedTemplate");

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
  // 3. SAVE FORM SUBMISSION
  // =====================================================
  const submission = await FormSubmission.create({
    formId: form._id,
    submittedBy: userId,
    submissionData: enrichedSubmissionData,
    status: "Submitted",
  });

  // =====================================================
  // 4. GENERATE INSTANCE COUNTER
  // =====================================================
  const counter = await Counter.findOneAndUpdate(
    { _id: "fms_instance" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );

  const sequence = String(counter.seq).padStart(5, "0");

  // =====================================================
  // 5. CREATE FMS INSTANCE
  // =====================================================
  const formSubmissionDate = new Date(); // Exact Form Hit/Submission Date & Time
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
  // 6. FETCH TEMPLATE TASKS
  // =====================================================
  const templateTasks = await FmsTask.find({
    fmsTemplateId: template._id,
  }).sort("taskId");

  if (!templateTasks.length) {
    return next(new AppError("No tasks found in linked template", 400));
  }

  // =====================================================
  // 7. CREATE ALL INSTANCE TASKS AT ONCE (INCLUDING RECURRING)
  // =====================================================
  const instanceTasks = [];

  for (let i = 0; i < templateTasks.length; i++) {
    const tmplTask = templateTasks[i];

    // GET USER SHIFT & DEPARTMENT CONTEXT
    const doer = await User.findById(tmplTask.assignedTo).populate(
      "assignShift",
    );

    if (!doer || !doer.assignShift) {
      continue;
    }

    const taskDeptContext =
      tmplTask.departmentOfAssignToUser || doer?.department || doer?._id;

    let dates = {
      startDate: null,
      dueDate: null,
    };

    const rawFreq = (tmplTask.frequency || "").trim();
    const freq = rawFreq.toLowerCase();

    // 🟢 CASE A: RECURRING TASKS (Daily, Weekly, Monthly, Anytime)
    if (RECURRING_FREQUENCIES.includes(rawFreq) || freq === "anytime") {
      let shiftStart = await nextWorkingShiftDate(
        formSubmissionDate,
        doer.assignShift._id,
        {},
        taskDeptContext,
      );

      // If submitted post-shift, move start date to next working shift
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
    // 🟢 CASE B: TASK LINKED WITH FORM OR "FORM EVENT+X" FREQUENCY
    else if (tmplTask.linkedWithForm || freq.startsWith("form event")) {
      let taskStartDate = new Date(formSubmissionDate);

      // Check Shift Window
      if (doer?.assignShift) {
        const shiftEnd = snapToShiftTime(
          formSubmissionDate,
          doer.assignShift,
          false,
        );

        // Post-Shift Submission (After 6 PM) -> Move Start Date to Next Working Day Shift Start
        if (formSubmissionDate >= shiftEnd) {
          let nextDay = new Date(formSubmissionDate);
          nextDay.setDate(nextDay.getDate() + 1);

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
      }

      let dueDate = new Date(taskStartDate);
      const xValue = Number(tmplTask.xValue || 0);

      if (freq.includes("hour")) {
        let calculatedDue = new Date(
          taskStartDate.getTime() + xValue * 60 * 60 * 1000,
        );

        if (doer?.assignShift) {
          const shiftEnd = snapToShiftTime(
            taskStartDate,
            doer.assignShift,
            false,
          );

          if (calculatedDue < shiftEnd) {
            dueDate = calculatedDue;
          } else {
            const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();
            let nextDay = new Date(taskStartDate);
            nextDay.setDate(nextDay.getDate() + 1);

            const nextWorkingDay = await nextWorkingShiftDate(
              nextDay,
              doer.assignShift._id,
              {},
              taskDeptContext,
            );

            const nextShiftStart = snapToShiftTime(
              nextWorkingDay,
              doer.assignShift,
              true,
            );

            dueDate = new Date(nextShiftStart.getTime() + overflowMs);
          }
        } else {
          dueDate = calculatedDue;
        }
      } else {
        const addedDaysDate = await addWorkingDaysHoliday(
          taskStartDate,
          xValue,
          doer.assignShift._id,
          tmplTask.isDependent,
          {},
          taskDeptContext,
        );

        if (addedDaysDate) {
          dueDate = addedDaysDate;
        }

        if (doer?.assignShift) {
          dueDate = snapToShiftTime(dueDate, doer.assignShift, false);
        }
      }

      dates = {
        startDate: taskStartDate,
        dueDate,
      };
    }
    // 🟢 CASE C: STANDARD / CALCULATED DEPENDENT DATES
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

    // UNIQUE RUNTIME TASK ID
    const runtimeTaskId = `${instance.instanceId}-${tmplTask.taskId}`;

    // STRICT BOOLEAN FOR DECISION STEP
    const isDecisionStep =
      tmplTask.decisionStep === true ||
      tmplTask.decisionStep === "yes" ||
      tmplTask.decisionStep === "true";

    // CREATE INSTANCE TASK DATA
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

//**GET SUBMISSION RESPONSE AND RECORD */
export const getFormSubmissions = async (req, res) => {
  try {
    const { formId } = req.params;

    const submissions = await FormSubmission.find({
      formId,
    })
      .populate("submittedBy", "name employeeCode")
      .populate("triggeredInstance", "instanceId status")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: submissions.length,
      data: submissions,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
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
