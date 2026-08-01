import mongoose from "mongoose";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsInstance from "../models/FmsInstance.js";
import FmsTemplate from "../models/FmsTemplate.js";
import OpenForm from "../models/OpenForm.js";
import FormSubmission from "../models/FormSubmission.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";

// ─────────────────────────────────────────────────────────────────────────
// GET /api/fms-instance-tasks/:taskId/decision-info
// Frontend calls this when user clicks "Complete" on a task.
// Returns: hasDecision, decisionYesAction, linkedForm (if trigger_fms)
// ─────────────────────────────────────────────────────────────────────────
export const getDecisionInfo = handleAsync(async (req, res, next) => {
  const task = await FmsInstanceTask.findById(req.params.taskId)
    .populate("triggerFmsTemplate", "fmsId templateName fmsDuration")
    .lean();

  if (!task) return next(new AppError("Task not found", 404));

  // No decision → just complete normally
  if (!task.decisionStep) {
    return res.json({ success: true, data: { hasDecision: false } });
  }

  // For trigger_fms: find the OpenForm linked to that template
  let linkedForm = null;
  if (
    task.decisionYesAction === "trigger_fms" &&
    task.triggerFmsTemplate?._id
  ) {
    linkedForm = await OpenForm.findOne({
      linkedTemplate: task.triggerFmsTemplate._id,
      isActive: true,
      status: "published",
      isDeleted: false,
    })
      .select("_id formName slug formUrl fields")
      .lean();
  }

  return res.json({
    success: true,
    data: {
      hasDecision: true,
      decisionAnswer: task.decisionAnswer, // null = not yet answered
      decisionYesAction: task.decisionYesAction, // "terminate" | "trigger_fms"
      triggerFmsTemplate: task.triggerFmsTemplate,
      linkedForm, // null for terminate / no form
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/fms-instance-tasks/:taskId/decision
//
// Body:
//   answer       "yes" | "no"
//   remark       string  (required on yes)
//   submissionId ObjectId (required when trigger_fms + linkedForm exists)
// ─────────────────────────────────────────────────────────────────────────
// export const submitDecision = handleAsync(async (req, res, next) => {
//   const { taskId } = req.params;
//   const { answer, remark, submissionId } = req.body;
//   const userId = req.cookies.userId || req.user?._id;

//   // 1. Basic validation
//   if (!["yes", "no"].includes(answer)) {
//     return next(new AppError('answer must be "yes" or "no"', 400));
//   }
//   if (answer === "yes" && !remark?.trim()) {
//     return next(new AppError("Remark is required when choosing Yes", 400));
//   }

//   // 2. Fetch and validate task
//   const task = await FmsInstanceTask.findById(taskId);
//   if (!task) return next(new AppError("Task not found", 404));
//   if (!task.decisionStep)
//     return next(new AppError("This task has no decision step", 400));
//   if (task.status === "Completed")
//     return next(new AppError("Task already completed", 400));
//   if (task.decisionAnswer !== null)
//     return next(new AppError("Decision already submitted", 400));

//   // ══════════════════════════════════════════════════════════════════
//   // ANSWER = "NO" → normal completion
//   // ══════════════════════════════════════════════════════════════════
//   if (answer === "no") {
//     task.decisionAnswer = "no";
//     task.decisionRemark = remark || null;
//     task.status = "Completed";
//     task.completedAt = new Date();
//     task.completedBy = userId;
//     await task.save();

//     return res.json({
//       success: true,
//       message: "Task completed successfully.",
//       data: { action: "completed" },
//     });
//   }

//   // ══════════════════════════════════════════════════════════════════
//   // ANSWER = "YES" + TERMINATE → stop the entire FMS instance
//   // ══════════════════════════════════════════════════════════════════
//   if (task.decisionYesAction === "terminate") {
//     task.decisionAnswer = "yes";
//     task.decisionRemark = remark;
//     task.status = "Completed";
//     task.completedAt = new Date();
//     task.completedBy = userId;
//     await task.save();

//     // Terminate the parent instance
//     const instance = await FmsInstance.findById(task.fmsInstanceId);
//     if (!instance) return next(new AppError("FMS instance not found", 404));

//     instance.status = "Stopped";
//     instance.isStopped = true;
//     instance.stoppedBy = userId;
//     instance.stoppedReason = remark;
//     await instance.save();

//     // Stop all remaining active tasks
//     await FmsInstanceTask.updateMany(
//       {
//         fmsInstanceId: task.fmsInstanceId,
//         _id: { $ne: task._id },
//         status: { $nin: ["Completed", "Stopped"] },
//       },
//       { $set: { status: "Stopped" } },
//     );

//     return res.json({
//       success: true,
//       message: "FMS instance terminated.",
//       data: {
//         action: "terminated",
//         instanceId: task.fmsInstanceId,
//         alertMessage: `FMS instance has been terminated. Reason: ${remark}`,
//       },
//     });
//   }

//   // ══════════════════════════════════════════════════════════════════
//   // ANSWER = "YES" + TRIGGER_FMS → launch a new FMS instance
//   // ══════════════════════════════════════════════════════════════════
//   if (task.decisionYesAction === "trigger_fms") {
//     if (!task.triggerFmsTemplate) {
//       return next(
//         new AppError("No FMS template configured on this decision step", 400),
//       );
//     }

//     const template = await FmsTemplate.findById(task.triggerFmsTemplate);
//     if (!template || template.isDeleted) {
//       return next(new AppError("Trigger FMS template not found", 404));
//     }

//     // Find linked OpenForm (if any)
//     const linkedForm = await OpenForm.findOne({
//       linkedTemplate: template._id,
//       isActive: true,
//       isDeleted: false,
//     });

//     // If form exists → submissionId is mandatory
//     if (linkedForm) {
//       if (!submissionId) {
//         return next(
//           new AppError(
//             "Form submission ID is required. Submit the linked form first.",
//             400,
//           ),
//         );
//       }
//       const submission = await FormSubmission.findById(submissionId);
//       if (!submission)
//         return next(new AppError("Form submission not found", 404));
//       if (String(submission.formId) !== String(linkedForm._id)) {
//         return next(
//           new AppError("Submission does not match the linked form", 400),
//         );
//       }
//       task.decisionSubmissionId = submission._id;
//     }

//     // Create the new FMS instance
//     const newInstance = await FmsInstance.create({
//       fmsTemplateId: template._id,
//       instanceName: template.templateName,
//       startDate: new Date(),
//       endDate:
//         template.fmsDuration === "Fixed Period" ? template.endDate : null,
//       fmsDuration: template.fmsDuration,
//       manager: template.manager,
//       srManager: template.srManager || null,
//       createdBy: userId,
//       triggerType: "DECISION_STEP",
//       formId: linkedForm?._id || null,
//       submissionId: submissionId || null,
//       status: "Ongoing",
//       runtimeContext: {
//         triggeredByTask: task._id,
//         triggeredByInstance: task.fmsInstanceId,
//         remark,
//       },
//     });

//     // Automatically trigger initial task creation for newly spawned FMS Instance
//     if (typeof generateRecurringFmsTasks === "function") {
//       await generateRecurringFmsTasks(newInstance._id);
//     }

//     // Mark current task complete
//     task.decisionAnswer = "yes";
//     task.decisionRemark = remark;
//     task.triggeredInstanceId = newInstance._id;
//     task.status = "Completed";
//     task.completedAt = new Date();
//     task.completedBy = userId;
//     await task.save();

//     return res.json({
//       success: true,
//       message: "New FMS instance triggered successfully.",
//       data: {
//         action: "triggered",
//         newInstanceId: newInstance._id,
//         templateName: template.templateName,
//         linkedFormSlug: linkedForm?.slug || null,
//         linkedFormUrl: linkedForm?.formUrl || null,
//       },
//     });
//   }

//   return next(
//     new AppError(`Unknown decisionYesAction: ${task.decisionYesAction}`, 400),
//   );
// });
export const submitDecision = handleAsync(async (req, res, next) => {
  const { taskId } = req.params;
  const { answer, remark, submissionId } = req.body;
  const userId = req.cookies.userId || req.user?._id;

  // 1. Basic validation
  if (!["yes", "no"].includes(answer)) {
    return next(new AppError('answer must be "yes" or "no"', 400));
  }
  if (answer === "yes" && !remark?.trim()) {
    return next(new AppError("Remark is required when choosing Yes", 400));
  }

  // 2. Fetch and validate task
  const task = await FmsInstanceTask.findById(taskId);
  if (!task) return next(new AppError("Task not found", 404));
  if (!task.decisionStep)
    return next(new AppError("This task has no decision step", 400));
  if (task.status === "Completed")
    return next(new AppError("Task already completed", 400));
  if (task.decisionAnswer !== null)
    return next(new AppError("Decision already submitted", 400));

  // ══════════════════════════════════════════════════════════════════
  // ANSWER = "NO" → normal completion
  // ══════════════════════════════════════════════════════════════════
  if (answer === "no") {
    task.decisionAnswer = "no";
    task.decisionRemark = remark || null;
    task.status = "Completed";
    task.completedAt = new Date();
    task.completedBy = userId;
    await task.save();

    return res.json({
      success: true,
      message: "Task completed successfully.",
      data: { action: "completed" },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // ANSWER = "YES" + TERMINATE → stop the entire FMS instance
  // ══════════════════════════════════════════════════════════════════
  if (task.decisionYesAction === "terminate") {
    // 1. Current decision task ko complete + terminated update karein
    task.decisionAnswer = "yes";
    task.decisionRemark = remark;
    task.status = "Completed";
    task.isTerminated = true; // 👈 CURRENT TASK PAR BHI SET KAREIN
    task.completedAt = new Date();
    task.completedBy = userId;
    await task.save();

    // 2. Terminate the parent instance
    const instance = await FmsInstance.findById(task.fmsInstanceId);
    if (!instance) return next(new AppError("FMS instance not found", 404));

    instance.status = "Stopped";
    instance.isStopped = true;
    instance.stoppedBy = userId;
    instance.isTerminated = true;
    instance.stoppedReason = remark;
    await instance.save();

    // 3. Stop all remaining active/pending tasks for this instance
    const updateResult = await FmsInstanceTask.updateMany(
      {
        fmsInstanceId: task.fmsInstanceId,
        // _id: { $ne: task._id },
        // status: { $nin: ["Completed", "Stopped"] },
      },
      {
        $set: {
          status: "Terminated",
          isTerminated: true,
        },
      },
    );

    console.log(
      `Updated ${updateResult.modifiedCount} remaining tasks to Terminated.`,
    );

    return res.json({
      success: true,
      message: "FMS instance terminated.",
      data: {
        action: "terminated",
        instanceId: task.fmsInstanceId,
        alertMessage: `FMS instance has been terminated. Reason: ${remark}`,
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // ANSWER = "YES" + TRIGGER_FMS → validate & complete task (NO INSTANCE CREATION)
  // ══════════════════════════════════════════════════════════════════
  if (task.decisionYesAction === "trigger_fms") {
    if (!task.triggerFmsTemplate) {
      return next(
        new AppError("No FMS template configured on this decision step", 400),
      );
    }

    const template = await FmsTemplate.findById(task.triggerFmsTemplate);
    if (!template || template.isDeleted) {
      return next(new AppError("Trigger FMS template not found", 404));
    }

    // Find linked active & published OpenForm
    const linkedForm = await OpenForm.findOne({
      linkedTemplate: template._id,
      status: "published",
      isActive: true,
      isDeleted: false,
    });

    // 1. Check if form is linked
    if (!linkedForm) {
      return next(
        new AppError(
          `No active published form is linked to the FMS template "${template.templateName}". Please link and publish a form first.`,
          400,
        ),
      );
    }

    // 2. Check if form submission exists
    if (!submissionId) {
      return next(
        new AppError(
          `Form submission is required. Please complete and submit the linked form ("${linkedForm.formName}") first.`,
          400,
        ),
      );
    }

    const submission = await FormSubmission.findById(submissionId);
    if (!submission) {
      return next(new AppError("Form submission not found", 404));
    }

    if (String(submission.formId) !== String(linkedForm._id)) {
      return next(
        new AppError("Submission does not match the linked form", 400),
      );
    }

    task.decisionSubmissionId = submission._id;

    // Mark current decision task complete
    task.decisionAnswer = "yes";
    task.decisionRemark = remark;
    task.status = "Completed";
    task.completedAt = new Date();
    task.completedBy = userId;
    await task.save();

    return res.json({
      success: true,
      message: "Decision step processed and task completed successfully.",
      data: {
        action: "completed",
        triggerFmsTemplateId: template._id,
        templateName: template.templateName,
        linkedFormSlug: linkedForm?.slug || null,
        linkedFormUrl: linkedForm?.formUrl || null,
      },
    });
  }

  return next(
    new AppError(`Unknown decisionYesAction: ${task.decisionYesAction}`, 400),
  );
});
