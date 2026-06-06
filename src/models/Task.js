import mongoose from "mongoose";
import Counter from "./Counter.js"; // Import the new Counter model
import User from "./User.js";

// ---------------------------------------------------------
// 1. BASE SCHEMA (Common Fields & Dependency Logic)
// ---------------------------------------------------------
const baseOptions = {
  discriminatorKey: "taskType",
  collection: "tasks",
  timestamps: true,
};

// Sub-schema for Checklist Items
const ChecklistItemSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
    isCompleted: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true },
); // Ensure each checklist item gets an ID

const BaseTaskSchema = new mongoose.Schema(
  {
    TaskId: {
      type: String,
      unique: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    bucketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TaskBucket",
      default: null,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },

    startDate: {
      type: Date,
      default: null,
      required: false,
    },

    taskEndDays: {
      type: Number,
      default: null,
    },

    checklist: {
      type: [ChecklistItemSchema],
      default: [],
    },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    departmentOfAssignToUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: false,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    status: {
      type: String,
      enum: ["Pending", "Completed", "Delayed", "Upcoming", "Overdue"],
      default: "Pending",
    },
    completedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    frequency: {
      type: String,
      enum: [
        "Daily",
        "Weekly",
        "Fortnightly",
        "Monthly",
        "Quarterly",
        "Half Yearly",
        "Yearly",
      ],
      required: false,
    },
    isDependent: {
      type: Boolean,
      default: false,
    },
    dependencyConfig: {
      taskDependent: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Task",
        default: null,
      },
      startTimeSetting: {
        type: String,
        enum: ["planned-to-planned", "actual-to-planned", null],
        default: null,
      },
      isDependentFrequency: {
        type: String,
        enum: ["T+X in days", "T-X in hours", null],
        default: null,
      },
      xValue: {
        type: Number,
        default: null,
      },
    },
    isVisible: {
      type: Boolean,
      default: false,
    },
    waitingForParent: {
      type: Boolean,
      default: false,
    },
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
    isReopen: {
      type: Boolean,
      default: false,
    },
    reopenedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reopenedAt: {
      type: Date,
      default: null,
    },
    reopenedReason: {
      type: String,
      default: null,
    },

    delegationFlowEnabled: {
      type: Boolean,
      default: false,
    },
    plannedStartDate: {
      type: Date,
      default: null,
    },
    plannedDueDate: {
      type: Date,
      default: null,
    },
    // distributionStatus: {
    //   type: String,
    //   enum: ["Awaiting Distribution", "Distributed", "Assigned"],
    //   default: "Assigned",
    // },

    // currentHolder: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "User",
    //   default: null,
    // },

    // finalAssignedTo: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "User",
    //   default: null,
    // },

    // delegationLevel: {
    //   type: Number,
    //   default: 0,
    // },
  },
  baseOptions,
);

// --- MIDDLEWARE: Validate Dependency Logic on the Base ---
BaseTaskSchema.pre("validate", function (next) {
  if (this.isDependent) {
    if (!this.dependencyConfig.taskDependent)
      this.invalidate(
        "dependencyConfig.taskDependent",
        "Parent Task is required",
      );
    if (!this.dependencyConfig.startTimeSetting)
      this.invalidate(
        "dependencyConfig.startTimeSetting",
        "Start Time Setting is required",
      );
    if (!this.dependencyConfig.isDependentFrequency)
      this.invalidate(
        "dependencyConfig.isDependentFrequency",
        "Frequency/Lag Type is required",
      );
    if (this.dependencyConfig.xValue === null)
      this.invalidate("dependencyConfig.xValue", "X Value is required");
  }
  next();
});

// --- MIDDLEWARE: Generate TaskId and populate departmentOfAssignToUser on new document ---
BaseTaskSchema.pre("save", async function (next) {
  if (this.isNew) {
    if (!this.TaskId) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const period = `${yy}${mm}`; // e.g., '2512'

      const counter = await Counter.findByIdAndUpdate(
        { _id: `taskId-${period}` },
        { $inc: { seq: 1 } },
        { new: true, upsert: true },
      );
      this.TaskId = `${period}${counter.seq.toString().padStart(4, "0")}`; // e.g., '25120001'
    }

    if (!this.departmentOfAssignToUser && this.assignedTo) {
      try {
        const user = await User.findById(this.assignedTo);
        if (user && user.department && user.department.length > 0) {
          this.departmentOfAssignToUser = user.department[0];
        }
      } catch (error) {
        console.error("Error populating departmentOfAssignToUser:", error);
      }
    }
  }
  next();
});

// Initialize Base Model
const Task = mongoose.model("Task", BaseTaskSchema);

// ---------------------------------------------------------
// 2. DELEGATION TASK SCHEMA
// (Fields for Single/Standard Tasks)
// ---------------------------------------------------------
const DelegationTaskSchema = new mongoose.Schema({
  dueDate: {
    type: Date,
    default: null,
  },
  attachmentFile: {
    type: [String],
    default: [],
  },
  recurrenceTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Task",
    default: null,
  },
  recurringRefId: {
    type: String,
    default: null,
  },
  taskDoneBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
});

// ---------------------------------------------------------
// 3. RECURRING TASK SCHEMA
// (Fields for the Schedule/Pattern)
// ---------------------------------------------------------
const RecurringTaskSchema = new mongoose.Schema({
  frequency: {
    type: String,
    enum: [
      "Daily",
      "Weekly",
      "Fortnightly",
      "Monthly",
      "Quarterly",
      "Half Yearly",
      "Yearly",
    ],
    required: true,
  },
  weekDays: [
    {
      type: String,
      enum: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ],
    },
  ],

  endDate: {
    type: Date,
    default: null,
  },

  attachmentFile: {
    type: [String],
    default: [],
  },
});

// --- MIDDLEWARE: Ensure dueDate is null for Recurring Tasks ---
RecurringTaskSchema.pre("validate", function (next) {
  if (this.dueDate) {
    this.dueDate = undefined;
  }
  next();
});

// ---------------------------------------------------------
// CREATE DISCRIMINATORS & EXPORT
// ---------------------------------------------------------
const DelegationTask = Task.discriminator(
  "DelegationTask",
  DelegationTaskSchema,
);
const RecurringTask = Task.discriminator("RecurringTask", RecurringTaskSchema);

export { Task, DelegationTask, RecurringTask };
export default Task;
