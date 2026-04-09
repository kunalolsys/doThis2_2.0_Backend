import mongoose from "mongoose";
import Counter from "./Counter.js";
import FmsTemplate from "./FmsTemplate.js";
import User from "./User.js";
import Department from "./Department.js";

const FmsTaskSchema = new mongoose.Schema(
  {
    fmsTemplateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsTemplate",
      required: true,
      index: true,
    },
    taskId: {
      type: String,
      unique: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    departmentOfAssignToUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: true,
      index: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    frequency: {
      type: String,
      enum: [
        "Anytime",
        "Daily",
        "Weekly",
        "Monthly",
        "Start+X in days",
        "Start+X in hours",
        // "Start-X in days",
        // "Start-X in hours",
        // "D+X",
        // "D-X",
        "Task+X in days",
        "Task+X in hours",
        "Task-X in days",
        "Task-X in hours",
        "Event+X in days",
        "Event+X in hours",
        "Event-X in days",
        "Event-X in hours",
      ],
      required: true,
    },
    xValue: {
      type: Number,
      default: 0,
    },
    isDependent: {
      type: Boolean,
      default: false,
      index: true,
    },
    dependentOn: String,
    startTimeSetting: {
      type: String,
      enum: ["planned-to-planned", "actual-to-planned"],
    },
    isRecurringTask: { type: Boolean, default: false },
    decisionStep: { type: Boolean, default: false },
    ifTrueStep: String,
    elseStep: String,
    taskEndDays: { type: Number, default: 0, min: 0 },
    // TENTATIVE - finalized at launch (NULL during template phase)
    tentativeStartDate: Date,
    tentativeDueDate: Date,
    // Modals
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
        isMandatory: { type: Boolean, default: false },
        completed: { type: Boolean, default: false }, // NEW: track if filled
      },
    ],
    // Audit
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// Indexes
FmsTaskSchema.index({ fmsTemplateId: 1, taskId: 1 });
FmsTaskSchema.index({ fmsTemplateId: 1, isDependent: 1 });
FmsTaskSchema.index({ dependentOn: 1 });

// Pre-save: taskId only
// FmsTaskSchema.pre("save", async function (next) {
//   if (this.isNew && !this.taskId) {
//     const template = await FmsTemplate.findById(this.fmsTemplateId);

//     const counter = await Counter.findByIdAndUpdate(
//       { _id: `fmsTask_${this.fmsTemplateId}` },
//       { $inc: { seq: 1 } },
//       { upsert: true, new: true }
//     );

//     this.taskId = `${template.fmsId}-${String(counter.seq).padStart(2, "0")}`;
//   }
//   next();
// });

FmsTaskSchema.virtual("template", {
  ref: "FmsTemplate",
  localField: "fmsTemplateId",
  foreignField: "_id",
});

FmsTaskSchema.set("toJSON", { virtuals: true });
FmsTaskSchema.set("toObject", { virtuals: true });

export default mongoose.model("FmsTask", FmsTaskSchema);
