import mongoose from "mongoose";

const TaskBucketSchema = new mongoose.Schema(
  {
    // =====================================================
    // BASIC
    // =====================================================
    bucketId: {
      type: String,
      unique: true,
      sparse: true,
    },
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
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deleteRemark: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);
TaskBucketSchema.pre("save", async function (next) {
  try {
    if (!this.isNew || this.bucketId) {
      return next();
    }

    // =====================================================
    // DATE PART
    // FORMAT: YYMMDD
    // =====================================================

    const now = new Date();

    const year = String(now.getFullYear()).slice(-2);

    const month = String(now.getMonth() + 1).padStart(2, "0");

    const day = String(now.getDate()).padStart(2, "0");

    const datePrefix = `${year}${month}${day}`;

    // =====================================================
    // TODAY COUNT
    // =====================================================

    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

    const endOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    );

    const todayCount = await mongoose.models.TaskBucket.countDocuments({
      createdAt: {
        $gte: startOfDay,
        $lt: endOfDay,
      },
    });

    // =====================================================
    // DAILY SEQUENCE
    // =====================================================

    const sequence = String(todayCount + 1).padStart(2, "0");

    // =====================================================
    // FINAL ID
    // FORMAT:
    // B-26052701
    // =====================================================

    this.bucketId = `B-${datePrefix}${sequence}`;

    next();
  } catch (err) {
    next(err);
  }
});
export default mongoose.model("TaskBucket", TaskBucketSchema);
