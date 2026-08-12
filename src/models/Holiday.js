import mongoose from "mongoose";

const holidaySchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    isGlobal: {
      type: Boolean,
      default: true,
    },
    applicableDepartments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Department",
      },
    ],
  },
  { timestamps: true },
);

export const Holiday = mongoose.model("Holiday", holidaySchema);
