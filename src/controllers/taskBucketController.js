import TaskBucket from "../models/TaskBucket.js";
import TaskAudienceMaster from "../models/TaskAudienceMaster.js";
import Task, { DelegationTask, RecurringTask } from "../models/Task.js";
import User from "../models/User.js";

// =======================================================
// CREATE BUCKET TASK
// =======================================================

export const createTaskBucket = async (req, res) => {
  try {
    const {
      title,
      description,

      assignmentMode,

      targetRole,
      targetUsers,

      startDate,
      taskEndDays,

      checklist,

      // dependency
      isDependent,
      taskDependent,
      startTimeSetting,
      isDependentFrequency,
      xValue,

      // recurrence
      isRecurrent,
      frequency,
      weekDays,
      endDate,
    } = req.body;

    // =====================================================
    // BOOLEAN FIX
    // =====================================================

    const dependentEnabled = String(isDependent) === "true";

    const recurrentEnabled = String(isRecurrent) === "true";

    // =====================================================
    // BASIC VALIDATION
    // =====================================================

    if (!title?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Title required",
      });
    }

    if (!description?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Description required",
      });
    }

    if (!assignmentMode) {
      return res.status(400).json({
        success: false,
        message: "Assignment mode required",
      });
    }

    // =====================================================
    // ROLE MODE
    // =====================================================

    if (assignmentMode === "Role" && !targetRole) {
      return res.status(400).json({
        success: false,
        message: "Target role required",
      });
    }

    // =====================================================
    // MEMBER MODE
    // =====================================================

    let parsedUsers = [];

    if (assignmentMode === "Users") {
      parsedUsers =
        typeof targetUsers === "string" ? JSON.parse(targetUsers) : targetUsers;

      if (!Array.isArray(parsedUsers) || parsedUsers.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Please select users",
        });
      }
    }

    // =====================================================
    // SIMPLE TASK VALIDATION
    // only when NOT dependent
    // =====================================================

    if (!dependentEnabled) {
      if (!startDate) {
        return res.status(400).json({
          success: false,
          message: "Start date required",
        });
      }

      // only normal task
      if (!recurrentEnabled && !taskEndDays) {
        return res.status(400).json({
          success: false,
          message: "Task End Days required",
        });
      }
    }

    // =====================================================
    // DEPENDENCY VALIDATION
    // =====================================================

    if (dependentEnabled) {
      if (!taskDependent) {
        return res.status(400).json({
          success: false,
          message: "Parent task required",
        });
      }

      if (!startTimeSetting) {
        return res.status(400).json({
          success: false,
          message: "Start time setting required",
        });
      }

      if (!isDependentFrequency) {
        return res.status(400).json({
          success: false,
          message: "Dependency frequency required",
        });
      }

      if (xValue === undefined || xValue === null || xValue === "") {
        return res.status(400).json({
          success: false,
          message: "X value required",
        });
      }
    }

    // =====================================================
    // RECURRING VALIDATION
    // =====================================================

    if (recurrentEnabled) {
      if (!frequency) {
        return res.status(400).json({
          success: false,
          message: "Recurring frequency required",
        });
      }

      if (
        frequency === "Weekly" &&
        (!weekDays || JSON.parse(weekDays).length === 0)
      ) {
        return res.status(400).json({
          success: false,
          message: "Please select weekly days",
        });
      }
    }

    // =====================================================
    // FILES
    // =====================================================

    let uploadedFiles = [];

    if (req.files?.length > 0) {
      uploadedFiles = req.files.map((file) => file.path);
    }

    // =====================================================
    // CREATE BUCKET
    // =====================================================
    // =====================================================
    // TARGET USER DISTRIBUTION INIT
    // =====================================================

    let distributionUsers = [];

    let assignedUsers = [];

    // =====================================================
    // USER BASED
    // =====================================================

    if (assignmentMode === "Users") {
      distributionUsers = parsedUsers.map((u) => ({
        user: u,
        status: "Pending",
        distributedAt: null,
      }));

      assignedUsers = parsedUsers;
    }

    // =====================================================
    // ROLE BASED
    // =====================================================

    if (assignmentMode === "Role") {
      const roleUsers = await User.find({
        role: targetRole,
      }).select("_id");

      assignedUsers = roleUsers.map((u) => u._id);

      distributionUsers = roleUsers.map((u) => ({
        user: u._id,
        status: "Pending",
        distributedAt: null,
      }));
    }

    // =====================================================
    // CREATE BUCKET
    // =====================================================

    const bucket = await TaskBucket.create({
      title: title.trim(),

      description: description.trim(),

      createdBy: req.cookies.userId || req.user._id,

      assignmentMode,

      // ===================================================
      // ROLE / MEMBERS
      // ===================================================

      targetRole: assignmentMode === "Role" ? targetRole : null,

      targetUsers: assignmentMode === "Users" ? parsedUsers : [],

      assignedTargetUsers: assignedUsers,
      targetUserDistribution: distributionUsers,

      // ===================================================
      // TASK DETAILS
      // ===================================================

      startDate: !dependentEnabled && startDate ? startDate : null,

      taskEndDays:
        !recurrentEnabled && taskEndDays ? Number(taskEndDays) : null,

      checklist: checklist ? JSON.parse(checklist) : [],

      // ===================================================
      // DEPENDENCY
      // ===================================================

      isDependent: dependentEnabled,

      dependencyConfig: dependentEnabled
        ? {
            taskDependent,

            startTimeSetting,

            isDependentFrequency,

            xValue: Number(xValue),
          }
        : {
            taskDependent: null,
            startTimeSetting: null,
            isDependentFrequency: null,
            xValue: null,
          },

      // ===================================================
      // RECURRENCE
      // ===================================================

      isRecurrent: recurrentEnabled,

      frequency: recurrentEnabled ? frequency : null,

      weekDays: recurrentEnabled && weekDays ? JSON.parse(weekDays) : [],

      endDate: recurrentEnabled && endDate ? endDate : null,

      // ===================================================
      // FILES
      // ===================================================

      attachmentFile: uploadedFiles,
    });

    return res.status(201).json({
      success: true,
      message: "Task bucket created successfully",
      data: bucket,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to create task bucket",
    });
  }
};

// =======================================================
// GET ALL BUCKETS
// =======================================================

export const getTaskBuckets = async (req, res) => {
  try {
    const userId = req.cookies.userId || req.user._id;

    // current logged in user
    const currentUser = await User.findById(userId).select("role");

    // =====================================================
    // GET BUCKETS
    // =====================================================

    const buckets = await TaskBucket.find({
      $or: [
        // =================================================
        // USER BASED BUCKETS
        // =================================================
        {
          assignmentMode: "Users",
          targetUserDistribution: {
            $elemMatch: {
              user: userId,
              status: "Pending",
            },
          },
        },

        // =================================================
        // ROLE BASED BUCKETS
        // =================================================
        {
          assignmentMode: "Role",
          targetRole: currentUser?.role,
        },
      ],
    })
      .populate("targetRole", "name")
      .populate("targetUsers", "name email")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: buckets.length,
      data: buckets,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch task buckets",
    });
  }
};

// =======================================================
// GET SINGLE BUCKET
// =======================================================

export const getSingleTaskBucket = async (req, res) => {
  try {
    const bucket = await TaskBucket.findById(req.params.id)
      .populate("targetRole", "name")
      .populate("targetUsers", "name email")
      .populate("createdBy", "name email")
      .populate("generatedTasks");

    if (!bucket) {
      return res.status(404).json({
        success: false,
        message: "Bucket not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: bucket,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch bucket",
    });
  }
};

// =======================================================
// DISTRIBUTE BUCKET TASK
// =======================================================

export const distributeTaskBucket = async (req, res) => {
  try {
    const { id } = req.params;

    const { selectedUsers } = req.body;
    const userId = req.cookies.userId || req.user._id;

    const currentUser = await User.findById(userId).select("role");

    const bucket = await TaskBucket.findOne({
      _id: id,
      $or: [
        {
          assignmentMode: "Users",
          assignedTargetUsers: userId,
        },

        {
          assignmentMode: "Role",
          targetRole: currentUser.role,
        },
      ],
    });
    if (!bucket) {
      return res.status(404).json({
        success: false,
        message: "Bucket not found",
      });
    }

    // if (bucket.distributionStatus === "Distributed") {
    //   return res.status(400).json({
    //     success: false,
    //     message: "Bucket already distributed",
    //   });
    // }
    const managerDistribution = bucket.targetUserDistribution.find(
      (d) => String(d.user) === String(userId),
    );

    if (!managerDistribution) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized distribution access",
      });
    }

    if (managerDistribution.status === "Distributed") {
      return res.status(400).json({
        success: false,
        message: "You already distributed this bucket",
      });
    }
    // =====================================================
    // VALIDATION
    // =====================================================

    if (
      !selectedUsers ||
      !Array.isArray(selectedUsers) ||
      selectedUsers.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please select users",
      });
    }

    // =====================================================
    // GET SELECTED USERS ONLY
    // =====================================================

    const users = await User.find({
      _id: {
        $in: selectedUsers,
      },
    });

    if (!users.length) {
      return res.status(400).json({
        success: false,
        message: "No users found",
      });
    }

    // =====================================================
    // CREATE TASKS
    // =====================================================

    const createdTasks = [];

    for (const user of users) {
      const commonPayload = {
        title: bucket.title,

        description: bucket.description,

        assignedTo: user._id,

        finalAssignedTo: user._id,

        currentHolder: user._id,

        assignedBy: req.cookies.userId || req.user._id,

        createdBy: req.cookies.userId || req.user._id,

        updatedBy: req.cookies.userId || req.user._id,

        departmentOfAssignToUser: user?.department?.[0] || null,

        startDate: bucket.startDate,

        taskEndDays: bucket.taskEndDays,

        checklist: bucket.checklist,

        isDependent: bucket.isDependent,

        dependencyConfig: bucket.dependencyConfig,

        delegationFlowEnabled: true,

        distributionStatus: "Assigned",

        status: "Pending",
      };

      let task;

      // ===================================================
      // RECURRING
      // ===================================================

      if (bucket.isRecurrent) {
        task = await RecurringTask.create({
          ...commonPayload,

          frequency: bucket.frequency,

          weekDays: bucket.weekDays,

          endDate: bucket.endDate,

          attachmentFile: bucket.attachmentFile,
        });
      }

      // ===================================================
      // NORMAL
      // ===================================================
      else {
        task = await DelegationTask.create({
          ...commonPayload,

          attachmentFile: bucket.attachmentFile,
        });
      }

      createdTasks.push(task._id);
    }

    // =====================================================
    // UPDATE BUCKET
    // =====================================================

    // =====================================================
    // SAVE GENERATED TASKS
    // =====================================================

    bucket.generatedTasks.push(...createdTasks);

    // =====================================================
    // CURRENT MANAGER DISTRIBUTED
    // =====================================================

    managerDistribution.status = "Distributed";

    managerDistribution.distributedAt = new Date();

    // =====================================================
    // CHECK ALL MANAGERS DISTRIBUTED
    // =====================================================

    const pendingManagers = bucket.targetUserDistribution.filter(
      (u) => u.status === "Pending",
    );

    if (pendingManagers.length === 0) {
      bucket.distributionStatus = "Distributed";

      bucket.distributedAt = new Date();

      bucket.distributedBy = req.cookies.userId || req.user._id;
    }

    await bucket.save();

    return res.status(200).json({
      success: true,
      message: "Tasks distributed successfully",
      data: createdTasks,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// =======================================================
// DELETE BUCKET
// =======================================================

export const deleteTaskBucket = async (req, res) => {
  try {
    const bucket = await TaskBucket.findById(req.params.id);

    if (!bucket) {
      return res.status(404).json({
        success: false,
        message: "Bucket not found",
      });
    }

    await bucket.deleteOne();

    return res.status(200).json({
      success: true,
      message: "Bucket deleted successfully",
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: "Failed to delete bucket",
    });
  }
};

// =======================================================
// GET REPORTING USERS OF BUCKET TARGET USERS
// =======================================================

export const getBucketReportingUsers = async (req, res) => {
  try {
    const userId = req.cookies.userId || req.user._id;

    const users = await User.find({
      reportingManager: userId,
    })
      .populate("role", "name")
      .populate("reportingManager", "name")
      .select("name email role reportingManager");

    return res.status(200).json({
      success: true,
      data: users,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
