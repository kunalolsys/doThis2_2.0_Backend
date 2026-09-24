import mongoose from "mongoose";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import FormSubmission from "../models/FormSubmission.js";
import OpenForm from "../models/OpenForm.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import Role from "../models/Role.js";
import User from "../models/User.js"; // 👈 User model import add kiya gaya hai

export const updateFormSubmissionResponse = handleAsync(
  async (req, res, next) => {
    const { submissionId } = req.params;
    const { submissionData } = req.body;

    // Safe current User ID extraction
    const currentUserId = req.user?._id || req.cookies?.userId || null;

    // 1. 🚀 ENHANCED AUTHORIZATION CHECK
    let userRoleName = "";
    const roleFromReq = req.user?.role || req.cookies?.role;

    if (roleFromReq) {
      if (typeof roleFromReq === "object" && roleFromReq.name) {
        userRoleName = roleFromReq.name;
      } else if (mongoose.Types.ObjectId.isValid(roleFromReq)) {
        const roleDoc = await Role.findById(roleFromReq).lean();
        userRoleName = roleDoc?.name || "";
      } else {
        userRoleName = String(roleFromReq);
      }
    }

    // 🟢 FALLBACK: Agar middleware se Role nahi mila, toh Database se Direct User Query karein
    if (!userRoleName && currentUserId) {
      const dbUser = await User.findById(currentUserId)
        .populate("role", "name")
        .lean();

      if (dbUser && dbUser.role) {
        userRoleName = typeof dbUser.role === "object" ? dbUser.role.name : String(dbUser.role);
      }
    }

    console.log("Resolved User Role Name:", userRoleName);

    const isAdmin = ["Admin", "Owner", "SuperAdmin", "admin", "owner", "superadmin"].some(
      (r) => r.toLowerCase() === String(userRoleName).toLowerCase()
    );

    if (!isAdmin) {
      return next(
        new AppError(
          `Access Denied: Only Admins can edit form responses. (Detected Role: '${userRoleName || "None"}')`,
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

    // 3. Fetch Linked OpenForm Schema
    const formSchema = await OpenForm.findById(
      existingSubmission.formId,
    ).lean();

    let formattedSubmissionData = {
      ...(existingSubmission.submissionData || {}),
    };

    if (formSchema && Array.isArray(formSchema.fields)) {
      formSchema.fields.forEach((field) => {
        const fieldKey = field.fieldId;
        const updatedValue =
          submissionData[fieldKey] !== undefined
            ? submissionData[fieldKey]
            : existingSubmission.submissionData?.[fieldKey]?.value;

        formattedSubmissionData[fieldKey] = {
          value: updatedValue,
          label: field.label || fieldKey,
          fieldType: field.fieldType || "text",
          isTableColumn: Boolean(field.isTableColumn),
        };
      });

      Object.entries(submissionData).forEach(([key, val]) => {
        if (!formattedSubmissionData[key]) {
          formattedSubmissionData[key] = {
            value: val,
            label: key,
            fieldType: typeof val === "number" ? "number" : "text",
            isTableColumn: false,
          };
        }
      });
    } else {
      Object.entries(submissionData).forEach(([key, val]) => {
        formattedSubmissionData[key] = {
          value: val,
          label: key,
          fieldType: typeof val === "number" ? "number" : "text",
          isTableColumn: false,
        };
      });
    }

    // 4. Save and Mark Modified
    existingSubmission.submissionData = formattedSubmissionData;
    existingSubmission.markModified("submissionData");
    await existingSubmission.save();

    // 5. CASCADE SYNC
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
          updatedBy: currentUserId,
        },
      },
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