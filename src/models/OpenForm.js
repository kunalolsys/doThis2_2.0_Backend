import mongoose from "mongoose";
const OpenFormFieldSchema = new mongoose.Schema(
  {
    fieldId: {
      type: String,
      required: true,
    },

    label: {
      type: String,
      required: true,
    },

    fieldType: {
      type: String,
      enum: [
        "text",
        "textarea",
        "number",
        "email",
        "date",
        "select",
        "checkbox",
        "radio",
        "file",
        "url",
        "phone",
      ],
      required: true,
    },

    placeholder: String,

    options: [String],

    isRequired: {
      type: Boolean,
      default: false,
    },
    isTableColumn: { type: Boolean, default: false },

    defaultValue: mongoose.Schema.Types.Mixed,

    order: Number,
  },
  { _id: false },
);
const OpenFormSchema = new mongoose.Schema(
  {
    formName: {
      type: String,
      required: true,
    },

    description: String,

    linkedTemplate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FmsTemplate",
      required: true,
    },

    fields: [OpenFormFieldSchema],

    isActive: {
      type: Boolean,
      default: true,
    },

    allowMultipleSubmissions: {
      type: Boolean,
      default: true,
    },
    formUrl: {
      type: String,
      default: null,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
    },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  },
);
OpenFormSchema.index(
  { slug: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
    },
  },
);
export default mongoose.model("OpenForm", OpenFormSchema);
