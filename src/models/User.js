import mongoose from "mongoose";
import Counter from "./Counter.js";

const userSchema = new mongoose.Schema(
  {
    srNo: {
      type: Number,
      unique: true,
      index: true,
    },
    employeeCode: {
      type: String,
      default: "",
      unique: true,
    },
    companyCode: {
      type: String,
      // auto-generated on create if not provided
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    secondaryEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    mainEmailType: {
      type: String,
      default: "email",
      enum: ["email", "secondaryEmail"],
    },
    isEmailNotificationEnabled: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: function (v) {
          return /^\d{10}$/.test(v);
        },
        message: "Phone number must be exactly 10 digits.",
      },
    },
    department: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Department",
        required: false,
      },
    ],
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },
    reportingManager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    assignShift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkShift",
      required: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    emailVerificationToken: String,
    emailVerificationExpires: Date,
    passwordResetToken: String,
    passwordResetExpires: Date,
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    // isMailReceived: {
    //     type: Boolean,
    //     default: false,
    // }
  },
  { timestamps: true },
);

/// Add partial unique index for 'email' where isDeleted is false
// userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
// Unique companyCode when present
// userSchema.index({ companyCode: 1 }, { unique: true, sparse: true });

// Auto-increment Sr. No
userSchema.pre("save", async function (next) {
  if (this.isNew) {
    const last = await this.constructor.findOne({}, {}, { sort: { srNo: -1 } });
    this.srNo = last && last.srNo ? last.srNo + 1 : 1;

    // Auto-generate companyCode if not provided or set to 'null' placeholder
    const rawCompany = this.companyCode;
    if (
      !rawCompany ||
      String(rawCompany).trim() === "" ||
      String(rawCompany).toLowerCase() === "null"
    ) {
      const counter = await Counter.findByIdAndUpdate(
        { _id: "companyCode" },
        { $inc: { seq: 1 } },
        { new: true, upsert: true },
      );
      const seq = String(counter.seq).padStart(3, "0");
      this.companyCode = `emp${seq}`; // emp001
    }
  }
  next();
});

const User = mongoose.model("User", userSchema);

export default User;
