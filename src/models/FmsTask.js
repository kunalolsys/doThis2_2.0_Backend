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
        "None", // 🟢 ALLOW NONE FOR ROW 1 / STANDARD TASKS
        "Anytime",
        "Daily",
        "Weekly",
        "Monthly",
        "Start+X in days",
        "Start+X in hours",
        "Form Event+X in days", // 🟢 FORM EVENT RELATIVE DATES
        "Form Event+X in hours", // 🟢 FORM EVENT RELATIVE HOURS
        "Task+X in days",
        "Task+X in hours",
        "Task-X in days",
        "Task-X in hours",
        "Event+X in days",
        "Event+X in hours",
        "Event-X in days",
        "Event-X in hours",
      ],
      default: "None",
    },
    linkedWithForm: {
      type: Boolean,
      default: false, // 🟢 LINK WITH FORM TOGGLE
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
    taskEndDays: { type: Number, default: 0, min: 0 },
    tentativeStartDate: Date,
    tentativeDueDate: Date,
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
            "text",
            "textarea",
            "number",
            "email",
            "password",
            "phone",
            "date",
            "datetime",
            "time",
            "file",
            "image",
            "dropdown",
            "multiselect",
            "checkbox",
            "radio",
            "boolean",
            "url",
            "json",
            "richtext",
          ],
        },
        options: [
          {
            label: String,
            value: String,
          },
        ],
        isMandatory: { type: Boolean, default: false },
        completed: { type: Boolean, default: false },
      },
    ],
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    decisionStep: {
      type: Boolean,
      default: false,
    },
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
  },
  { timestamps: true },
);

FmsTaskSchema.index({ fmsTemplateId: 1, taskId: 1 });
FmsTaskSchema.index({ fmsTemplateId: 1, isDependent: 1 });
FmsTaskSchema.index({ dependentOn: 1 });

FmsTaskSchema.virtual("template", {
  ref: "FmsTemplate",
  localField: "fmsTemplateId",
  foreignField: "_id",
});

FmsTaskSchema.set("toJSON", { virtuals: true });
FmsTaskSchema.set("toObject", { virtuals: true });

export default mongoose.model("FmsTask", FmsTaskSchema);
