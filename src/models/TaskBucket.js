import mongoose from "mongoose";

const TaskBucketSchema = new mongoose.Schema(
  {
    // =====================================================
    // BASIC
    // =====================================================

    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    distributionStatus: {
      type: String,
      enum: ["Pending", "Partially Distributed", "Distributed"],
      default: "Pending",
    },
    // =====================================================
    // ASSIGNMENT MODE
    // =====================================================

    assignmentMode: {
      type: String,
      enum: ["Role", "Users"],
      required: true,
    },

    // role assignment
    targetRole: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      default: null,
    },

    // member assignment
    targetUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    assignedTargetUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    targetUserDistribution: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },

        status: {
          type: String,
          enum: ["Pending", "Distributed"],
          default: "Pending",
        },

        distributedAt: {
          type: Date,
          default: null,
        },
      },
    ],
    // =====================================================
    // TASK DETAILS
    // =====================================================

    startDate: {
      type: Date,
      default: null,
    },

    taskEndDays: {
      type: Number,
      default: null,
    },

    checklist: [
      {
        text: String,
        isCompleted: {
          type: Boolean,
          default: false,
        },
      },
    ],

    // =====================================================
    // DEPENDENCY
    // =====================================================

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

    // =====================================================
    // RECURRENCE
    // =====================================================

    isRecurrent: {
      type: Boolean,
      default: false,
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
      default: null,
    },

    weekDays: [String],

    endDate: {
      type: Date,
      default: null,
    },

    // =====================================================
    // FILES
    // =====================================================

    attachmentFile: {
      type: [String],
      default: [],
    },

    // =====================================================
    // GENERATED TASKS
    // =====================================================

    generatedTasks: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Task",
      },
    ],
    status: {
      type: String,
      enum: ["Pending", "Completed"],
      default: "Pending",
    },
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    remark: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("TaskBucket", TaskBucketSchema);
