import mongoose from "mongoose";
import FormSubmission from "../models/FormSubmission.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import OpenForm from "../models/OpenForm.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import Role from "../models/Role.js";

// 🟢 ADMIN ONLY: Edit Open Form Submission Response & Sync to All Related FMS Instance Tasks
export const updateFormSubmissionResponse = handleAsync(
  async (req, res, next) => {
    const { submissionId } = req.params;
    const { submissionData } = req.body;

    // 1. Authorization Check: Keval Admin/Owner edit kar sakte hain
    let userRoleName = "";

    const roleFromReq = req.user?.role || req.cookies?.role;

    if (roleFromReq) {
      if (mongoose.Types.ObjectId.isValid(roleFromReq)) {
        // Agar Role ID hai, to Role model se fetch karein
        const roleDoc = await Role.findById(roleFromReq).lean();
        userRoleName = roleDoc?.name || "";
      } else if (typeof roleFromReq === "object" && roleFromReq.name) {
        // Agar role object populated hai
        userRoleName = roleFromReq.name;
      } else {
        // Agar role direct string hai
        userRoleName = String(roleFromReq);
      }
    }

    console.log("Resolved User Role Name:", userRoleName);

    const isAdmin = ["Admin", "Owner", "SuperAdmin"].includes(userRoleName);

    if (!isAdmin) {
      return next(
        new AppError(
          "Access Denied: Only Admins can edit form responses.",
          403,
        ),
      );
    }

    if (!submissionId || !mongoose.Types.ObjectId.isValid(submissionId)) {
      return next(new AppError("Valid Submission ID is required", 400));
    }

    if (!submissionData || typeof submissionData !== "object") {
      return next(new AppError("Submission data payload is required", 400));
    }

    // 2. Fetch Existing Form Submission
    const existingSubmission = await FormSubmission.findById(submissionId);
    if (!existingSubmission) {
      return next(new AppError("Form submission record not found", 404));
    }

    // 3. Fetch Linked OpenForm Schema for validation & metadata labeling
    const formSchema = await OpenForm.findById(
      existingSubmission.formId,
    ).lean();

    // Construct structured submission payload with label/field properties
    let formattedSubmissionData = {};

    if (formSchema && Array.isArray(formSchema.fields)) {
      formSchema.fields.forEach((field) => {
        const fieldKey = field.fieldId;
        const updatedValue =
          submissionData[fieldKey] !== undefined
            ? submissionData[fieldKey]
            : existingSubmission.submissionData?.[fieldKey]?.value;

        formattedSubmissionData[fieldKey] = {
          value: updatedValue,
          label: field.label,
          fieldType: field.fieldType,
          isTableColumn: Boolean(field.isTableColumn),
        };
      });
    } else {
      // Fallback if form schema is unavailable
      Object.entries(submissionData).forEach(([key, val]) => {
        formattedSubmissionData[key] = {
          value: val,
          label: key,
          fieldType: typeof val === "number" ? "number" : "text",
          isTableColumn: false,
        };
      });
    }

    // 4. Update the FormSubmission Document
    existingSubmission.submissionData = formattedSubmissionData;
    await existingSubmission.save();

    // 5. 🚀 CASCADE SYNC: Update submissionData across ALL matching FmsInstanceTasks
    const updateResult = await FmsInstanceTask.updateMany(
      {
        $or: [
          { submissionId: existingSubmission._id },
          { decisionSubmissionId: existingSubmission._id },
        ],
      },
      {
        $set: {
          submissionData: formattedSubmissionData,
          updatedBy: req.user._id,
        },
      },
    );

    console.log(
      `✅ Form Response Updated! Synced ${updateResult.modifiedCount} FmsInstanceTask records.`,
    );

    res.status(200).json({
      success: true,
      message: `Form response updated successfully and synced to ${updateResult.modifiedCount} task records.`,
      data: {
        submission: existingSubmission,
        syncedTaskCount: updateResult.modifiedCount,
      },
    });
  },
);
