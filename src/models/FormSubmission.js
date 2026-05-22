import mongoose from "mongoose";

const FormSubmissionSchema = new mongoose.Schema(
  {
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OpenForm",
      required: true,
    },

    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    submissionData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    triggeredInstance: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsInstance",
    },

    status: {
      type: String,
      enum: ["Submitted", "Triggered", "Failed"],
      default: "Submitted",
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("FormSubmission", FormSubmissionSchema);
