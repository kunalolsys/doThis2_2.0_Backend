import mongoose from "mongoose";

const logSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ["CREATE", "UPDATE", "DELETE"],
      required: true,
    },

    module: {
      type: String,
      required: true,
    },

    documentId: {
      type: mongoose.Schema.Types.ObjectId,
    },

    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    oldData: {
      type: Object,
    },

    newData: {
      type: Object,
    },

    message: {
      type: String,
    },
  },
  { timestamps: true },
);

export const Log = mongoose.model("Log", logSchema);