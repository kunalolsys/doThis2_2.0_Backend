import mongoose from "mongoose";

const FmsInstanceTaskSchema = new mongoose.Schema(
  {
    fmsInstanceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsInstance",
      required: true,
      index: true,
    },
    fmsTaskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsTask",
      required: true,
    },
    taskId: { type: String, required: true, index: true },
    description: { type: String, required: true },
    departmentOfAssignToUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    frequency: { type: String, required: true },
    xValue: Number,
    isDependent: { type: Boolean, default: false },
    dependentOn: String,
    startTimeSetting: String,
    taskEndDays: { type: Number, default: 0 },

    // FINAL RUNTIME DATES (computed at launch)
    // plannedStartDate: { type: Date, required: true },
    plannedStartDate: Date,
    plannedDueDate: Date,

    // ACTUAL progress
    actualStartDate: Date,
    actualDueDate: Date,
    actualCompleteDate: Date,
    status: {
      type: String,
      enum: [
        "Upcoming",
        "Pending",
        "Delayed",
        "Overdue",
        "Completed",
        "Onhold",
        "Stopped",
        "Not Done",
        "Terminated"
      ],
      default: "Upcoming",
      index: true,
    },
    notDoneRemark: {
      type: String,
      default: null,
    },
    notDoneBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    delayDays: Number,
    waitingForParent: { type: Boolean, default: false },
    decisionResult: String,
    isVisible: { type: Boolean, default: false }, // Shift-aware visibility
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    queryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Queries",
      default: null,
    },
    checklist: [
      {
        text: { type: String, required: true },
        completed: { type: Boolean, default: false },
      },
    ],
    createdForm: [
      {
        fieldName: { type: String, required: true },
        fieldType: {
          type: String,
          enum: [
            "text", // simple text
            "textarea", // long text / description
            "number", // numeric input
            "email", // email input
            "password", // password field
            "phone", // mobile number
            "date", // date picker
            "datetime", // date + time
            "time", // only time
            "file", // file upload
            "image", // image upload
            "dropdown", // select (single)
            "multiselect", // select (multiple)
            "checkbox", // true/false or multiple options
            "radio", // single choice
            "boolean", // true/false toggle
            "url", // link input
            "json", // structured data
            "richtext", // formatted editor (bold, etc.)
          ],
        },
        options: [
          {
            label: String,
            value: String,
          },
        ],
        isMandatory: { type: Boolean, default: false },
        completed: { type: Boolean, default: false }, // NEW: track if filled
      },
    ],
    formData: {
      // e.g. { "clientName": "ABC", "amount": 1000, "file": {path: "..."} }
      type: mongoose.Schema.Types.Mixed, // flexible for all fieldTypes
    },
    // Audit
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Open Form runtime traceability (optional; used by OpenForm submissions)
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FormSubmission",
    },
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OpenForm",
    },
    submissionData: {
      type: mongoose.Schema.Types.Mixed,
    },
    // instanceCode: String,

    // Idempotency keys for “every trigger should generate tasks”
    // - recurrenceKey: cron occurrence key (e.g., YYYY-MM-DD)
    // - triggerKey: generic occurrence key for dependency activation/generation
    recurrenceKey: String,
    triggerKey: String,

    // ── Decision step runtime state ─────────────────────────────────────────
    decisionStep: { type: Boolean, default: false },
    decisionYesAction: {
      type: String,
      enum: ["terminate", "trigger_fms", null],
      default: null,
    },
    triggerFmsTemplate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsTemplate",
      default: null,
    },
    // Filled at runtime
    decisionAnswer: { type: String, enum: ["yes", "no", null], default: null },
    decisionRemark: { type: String, default: null },
    decisionSubmissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FormSubmission",
      default: null,
    },
    triggeredInstanceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsInstance",
      default: null,
    },
    completedAt: { type: Date, default: null },
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    isTerminated: { type: Boolean, default: false },
  },
  { timestamps: true },
);

FmsInstanceTaskSchema.index(
  { fmsInstanceId: 1, taskId: 1, recurrenceKey: 1 },
  {
    unique: true,
    sparse: true,
  },
);
FmsInstanceTaskSchema.index({ fmsInstanceId: 1, status: 1 });
FmsInstanceTaskSchema.index({ assignedTo: 1, isVisible: 1 });

export default mongoose.model("FmsInstanceTask", FmsInstanceTaskSchema);
