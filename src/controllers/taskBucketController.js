import TaskBucket from "../models/TaskBucket.js";
import TaskAudienceMaster from "../models/TaskAudienceMaster.js";
import Task, { DelegationTask, RecurringTask } from "../models/Task.js";
import User from "../models/User.js";
import {
  addWorkingDaysHoliday,
  nextWorkingShiftDate,
} from "../utils/dateCalculator.js";
import Conversations from "../models/queries/Conversation.js";
import { getIO } from "../socket.js";
import Notifications from "../models/queries/Notification.js";
import { taskAssignedTemplate } from "../services/templates/taskAssignedTemp.js";
import sendEmail from "../services/emailService.js";
import { bucketCompletedTemplate } from "../services/templates/bucketCompletedTemplate.js";
import { taskBucketAssignedTemplate } from "../services/templates/taskBucketAssignedTemp.js";
import { sendNotification } from "../services/telegram/services/taskTelegramService.js";

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
      uploadedFiles = req.files.map(
        (file) => `${req.uploadFolder}/${file.filename}`,
      );
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
    // =====================================================
    // POPULATE USERS
    // =====================================================

    await bucket.populate([
      {
        path: "createdBy",
        select: "name email",
      },
      {
        path: "targetUsers",
        select: "name email",
      },
      {
        path: "targetRole",
        select: "name",
      },
    ]);

    // =====================================================
    // FINAL TARGET USERS
    // =====================================================

    let finalUsers = [];

    if (assignmentMode === "Users") {
      finalUsers = bucket.targetUsers || [];
    }

    if (assignmentMode === "Role") {
      finalUsers = await User.find({
        role: targetRole,
      }).select("_id name email");
    }

    // =====================================================
    // SOCKET IO
    // =====================================================

    const io = getIO();

    // =====================================================
    // SEND NOTIFICATION + EMAIL
    // =====================================================

    for (const user of finalUsers) {
      // ===================================================
      // REALTIME NOTIFICATION
      // ===================================================

      io.to(String(user._id)).emit("notification", {
        type: "TASK_BUCKET_CREATED",

        title: "New Task Bucket Assigned",

        description: `A new task bucket "${bucket.title}" has been assigned to you.`,

        bucketId: bucket._id,
      });

      // ===================================================
      // DATABASE NOTIFICATION
      // ===================================================

      await Notifications.create({
        user: user._id,

        fromUser: req.cookies.userId || req.user._id,

        type: "BUCKET_TASK_ASSIGNED",

        title: "New Task Bucket Assigned",

        description: `A new task bucket "${bucket.title}" has been assigned to you.`,

        relatedId: bucket._id,
      });

      // ===================================================
      // EMAIL
      // ===================================================

      if (user?.email) {
        const frontendUrl = `${process.env.BASE_URL}/bucket/my-bucket`;

        const emailTemplate = taskBucketAssignedTemplate({
          userName: user.name,

          bucketId: bucket.bucketId,

          bucketTitle: bucket.title,

          description: bucket.description,

          // assignmentMode: bucket.assignmentMode,

          createdAt: bucket.createdAt
            ? new Date(bucket.createdAt).toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })
            : "-",

          createdBy: req.user?.name || "Manager",

          frontendUrl,
        });

        sendEmail({
          to: user.email,

          subject: emailTemplate.subject,

          html: emailTemplate.html,
        });
      }
      sendNotification({
        type: "TASK_BUCKET_ASSIGNED",
        task: bucket,
        actor: req.user,
        userId: user._id,
      });
    }

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
    // QUERY PARAMS
    // =====================================================

    const search = req.query.search?.trim() || "";

    const status = req.query.status || "";

    const sortBy = req.query.sortBy || "newest";

    // =====================================================
    // SORT CONFIG
    // =====================================================

    let sortConfig = { createdAt: -1 };

    switch (sortBy) {
      case "oldest":
        sortConfig = { createdAt: 1 };
        break;

      case "title_asc":
        sortConfig = { title: 1 };
        break;

      case "title_desc":
        sortConfig = { title: -1 };
        break;

      case "status":
        sortConfig = { status: 1 };
        break;

      case "newest":
      default:
        sortConfig = { createdAt: -1 };
        break;
    }
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    // =====================================================
    // FILTER
    // =====================================================

    const filter = {
      isDeleted: false,
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
    };

    // =====================================================
    // SEARCH FILTER
    // =====================================================

    if (search) {
      filter.$and = [
        {
          $or: [
            {
              title: {
                $regex: search,
                $options: "i",
              },
            },

            {
              description: {
                $regex: search,
                $options: "i",
              },
            },

            {
              bucketId: {
                $regex: search,
                $options: "i",
              },
            },
          ],
        },
      ];
    }

    // =====================================================
    // STATUS FILTER
    // =====================================================

    if (status && status !== "all") {
      if (!filter.$and) {
        filter.$and = [];
      }

      filter.$and.push({
        status,
      });
    }

    // =====================================================
    // GET BUCKETS
    // =====================================================

    const buckets = await TaskBucket.find(filter)
      .populate("targetRole", "name")
      .populate("targetUsers", "name email")
      .populate("assignedTargetUsers", "name email")
      .populate("createdBy", "name email")
      .populate("completedBy", "name email")
      .populate("targetUserDistribution.user", "name email")
      .sort(sortConfig)
      .lean();

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
    const { selectedUsers = [] } = req.body;

    const userId = req.cookies.userId || req.user._id;

    // =====================================================
    // GET BUCKET
    // =====================================================
    const bucket = await TaskBucket.findById(id);

    if (!bucket) {
      return res.status(404).json({
        success: false,
        message: "Bucket not found",
      });
    }

    // =====================================================
    // GET USERS
    // =====================================================
    const users = await User.find({
      _id: { $in: selectedUsers },
    });

    if (!users.length) {
      return res.status(400).json({
        success: false,
        message: "No users found",
      });
    }

    // =====================================================
    // VALID USERS (ONLY REPORTING CHECK)
    // =====================================================
    const validUsers = users.filter(
      (u) => String(u.reportingManager) === String(userId),
    );

    if (!validUsers.length) {
      return res.status(400).json({
        success: false,
        message: "No valid reporting users",
      });
    }

    // =====================================================
    // 🔥 DUPLICATE CHECK (IMPORTANT FIX FOR BOTH TASK TYPES)
    // =====================================================
    const [existingDelegation, existingRecurring] = await Promise.all([
      DelegationTask.find({
        bucketId: bucket._id,
        assignedTo: { $in: validUsers.map((u) => u._id) },
      }).select("assignedTo"),

      RecurringTask.find({
        bucketId: bucket._id,
        assignedTo: { $in: validUsers.map((u) => u._id) },
      }).select("assignedTo"),
    ]);

    const assignedSet = new Set([
      ...existingDelegation.map((t) => String(t.assignedTo)),
      ...existingRecurring.map((t) => String(t.assignedTo)),
    ]);

    // =====================================================
    // FILTER ONLY NEW USERS
    // =====================================================
    const usersToAssign = validUsers.filter(
      (u) => !assignedSet.has(String(u._id)),
    );

    if (!usersToAssign.length) {
      return res.status(200).json({
        success: true,
        message: "All selected users already assigned",
        data: [],
      });
    }

    // =====================================================
    // CREATE TASKS
    // =====================================================
    const createdTasks = [];
    for (const user of usersToAssign) {
      const assignedUser = await User.findById(user._id).populate(
        "assignShift",
      );

      if (!assignedUser?.assignShift) {
        return res.status(400).json({
          success: false,
          message: `No workshift assigned to ${assignedUser?.name}`,
        });
      }

      const workShift = assignedUser.assignShift;

      // ============================
      // 1. START DATE (WORKSHIFT SAFE)
      // ============================
      let effectiveStartDate = bucket.startDate
        ? await nextWorkingShiftDate(bucket.startDate, workShift._id)
        : await nextWorkingShiftDate(new Date(), workShift._id);

      // ============================
      // 2. DUE DATE (TASK END DAYS LOGIC)
      // ============================
      let effectiveDueDate = null;

      if (bucket.taskEndDays && bucket.taskEndDays > 0) {
        effectiveDueDate = await addWorkingDaysHoliday(
          effectiveStartDate,
          bucket.taskEndDays,
          workShift._id,
        );
      }

      // ============================
      // BASE PAYLOAD (FIXED)
      // ============================
      const basePayload = {
        bucketId: bucket._id,

        title: bucket.title,
        description: bucket.description,

        assignedTo: assignedUser._id,
        // finalAssignedTo: assignedUser._id,
        // currentHolder: assignedUser._id,

        assignedBy: userId,
        createdBy: userId,
        updatedBy: userId,

        departmentOfAssignToUser: assignedUser?.department?.[0] || null,

        startDate: effectiveStartDate,
        dueDate: effectiveDueDate, // 🔥 IMPORTANT FIX

        taskEndDays: bucket.taskEndDays,

        checklist: bucket.checklist,

        isDependent: bucket.isDependent,
        dependencyConfig: bucket.dependencyConfig,

        // delegationFlowEnabled: true,
        // distributionStatus: "Assigned",
        status: "Pending",
      };

      let task;

      if (bucket.isRecurrent) {
        task = new RecurringTask({
          ...basePayload,
          frequency: bucket.frequency,
          weekDays: bucket.weekDays,
          endDate: bucket.endDate,
          attachmentFile: bucket.attachmentFile,
        });
      } else {
        task = new DelegationTask({
          ...basePayload,
          attachmentFile: bucket.attachmentFile,
        });
      }

      // =====================================================
      // CREATE CONVERSATION
      // =====================================================

      const conversation = await Conversations.create({
        taskId: task._id,
        taskType: task.taskType,
        participants: [assignedUser?._id, userId].filter(Boolean),
      });

      // attach conversation
      task.conversationId = conversation._id;

      await task.save();

      // =====================================================
      // REALTIME NOTIFICATION
      // =====================================================

      const io = getIO();

      io.to(String(assignedUser._id)).emit("notification", {
        type: "TASK_ASSIGNED",
        title: "New Task Assigned",
        description: `You received a new task "${task.title}"`,
        taskId: task._id,
        TaskId: task.TaskId,
      });

      // =====================================================
      // DATABASE NOTIFICATION
      // =====================================================

      await Notifications.create({
        user: assignedUser._id,
        fromUser: userId,

        type: "TASK_ASSIGNED",

        title: "New Task Assigned",

        description: `You received a new task "${task.title}"`,

        relatedId: task._id,
        taskId: task._id,
        conversationId: conversation._id,
      });

      // =====================================================
      // EMAIL
      // =====================================================

      if (assignedUser?.email) {
        const frontendUrl = `${
          process.env.BASE_URL
        }/my-day/mytasks?taskId=${task._id}`;

        const emailTemplate = taskAssignedTemplate({
          userName: assignedUser.name,
          taskId: task.TaskId,
          title: task.title,
          description: task.description,
          assignedBy: req.user?.name || "Manager",
          dueDate: task.dueDate
            ? new Date(task.dueDate).toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })
            : "N/A",
          frontendUrl,
        });

        sendEmail({
          to: assignedUser.email,
          subject: emailTemplate.subject,
          html: emailTemplate.html,
        });
      }
      sendNotification({
        type: "TASK_ASSIGNED",
        task: task,
        actor: req.user,
        userId: assignedUser._id,
      });
      createdTasks.push(task._id);
    }
    // =====================================================
    // UPDATE GENERATED TASKS
    // =====================================================

    bucket.generatedTasks.push(...createdTasks);

    // =====================================================
    // CHECK DISTRIBUTION STATUS
    // =====================================================

    // all reporting users under current manager
    const reportingUsers = await User.find({
      reportingManager: userId,
    }).select("_id");

    const reportingUserIds = reportingUsers.map((u) => String(u._id));

    // users who received this bucket task
    const distributedTasks = await Task.find({
      bucketId: bucket._id,
      assignedTo: { $in: reportingUserIds },
    }).select("assignedTo");

    const distributedUserSet = new Set(
      distributedTasks.map((t) => String(t.assignedTo)),
    );

    const totalUsers = reportingUserIds.length;

    const distributedCount = distributedUserSet.size;

    // =====================================================
    // FINAL STATUS
    // =====================================================

    if (distributedCount === 0) {
      bucket.distributionStatus = "Pending";
    } else if (distributedCount < totalUsers) {
      bucket.distributionStatus = "Partially Distributed";
    } else {
      bucket.distributionStatus = "Distributed";
    }

    await bucket.save();

    // =====================================================
    // RESPONSE
    // =====================================================
    return res.status(200).json({
      success: true,
      message: "Tasks distributed successfully",
      data: createdTasks,
    });
  } catch (err) {
    console.error(err);
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
    const { remark } = req.body;
    const bucketId = req.params.id;

    const userId = req.cookies.userId || req.user._id;

    // =====================================================
    // FIND BUCKET
    // =====================================================

    const bucket = await TaskBucket.findOne({
      _id: bucketId,
      isDeleted: {
        $ne: true,
      },
    });

    if (!bucket) {
      return res.status(404).json({
        success: false,
        message: "Bucket not found",
      });
    }

    // =====================================================
    // ONLY PENDING BUCKET CAN DELETE
    // =====================================================

    if (bucket.status !== "Pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending buckets can be deleted",
      });
    }

    // =====================================================
    // CHECK GENERATED TASKS
    // =====================================================

    const completedTaskExists = await Task.exists({
      _id: {
        $in: bucket.generatedTasks || [],
      },

      status: "Completed",
    });

    if (completedTaskExists) {
      return res.status(400).json({
        success: false,
        message:
          "Some generated tasks are completed. Please delete those tasks first.",
      });
    }

    // =====================================================
    // SOFT DELETE
    // =====================================================

    bucket.isDeleted = true;

    bucket.deletedBy = userId;

    bucket.deleteRemark = remark;

    bucket.deletedAt = new Date();

    await bucket.save();

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      success: true,
      message: "Bucket deleted successfully",
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to delete bucket",
    });
  }
};

// =====================================================
//  GET REPORTING USERS
// =====================================================
export const getBucketReportingUsers = async (req, res) => {
  try {
    const managerId = req.cookies.userId || req.user._id;
    const { id } = req.params;
    const bucket = await TaskBucket.findById(id);
    const users = await User.find({
      reportingManager: managerId,
    })
      .populate("role", "name")
      .populate("reportingManager", "name")
      .select("name email role reportingManager");

    const userIds = users.map((u) => u._id);

    // =====================================================
    // 2. CHECK TASKS EXISTENCE (ONLY FLAG PURPOSE)
    // =====================================================
    const tasks = await Task.find({
      bucketId: id,
      assignedTo: { $in: userIds },
    }).select("assignedTo bucketId status completedAt");

    // build map: userId -> has bucket task
    const bucketTaskMap = new Map();

    for (const task of tasks) {
      const userId = String(task.assignedTo);
      // if multiple bucket tasks exist,
      // keep latest completed info
      if (!bucketTaskMap.has(userId)) {
        bucketTaskMap.set(userId, {
          hasBucketTask: true,
          completedStatus: task.status || "Pending",
          completedAt: task.completedAt || null,
        });
      }
    }
    // =====================================================
    // 3. ATTACH ONLY ONE FIELD TO USER
    // =====================================================
    const result = users.map((user) => {
      const obj = user.toObject();
      const taskInfo = bucketTaskMap.get(String(user._id));
      obj.hasBucketTask = bucketTaskMap.has(String(user._id)) ? true : false;
      obj.completedStatus = taskInfo ? taskInfo.completedStatus : "No Task";

      obj.completedAt = taskInfo ? taskInfo.completedAt : null;

      return obj;
    });

    // =====================================================
    // RESPONSE
    // =====================================================
    return res.status(200).json({
      success: true,
      count: result.length,
      data: result,
      isBucketComplete: bucket.status == "Completed" || false,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch reporting users",
    });
  }
};
export const completeTaskBucket = async (req, res) => {
  try {
    const { id } = req.params;

    const { remark } = req.body;

    const userId = req.cookies.userId || req.user._id;

    // =====================================================
    // GET BUCKET
    // =====================================================

    const bucket = await TaskBucket.findById(id).populate(
      "createdBy",
      "name email",
    );

    if (!bucket) {
      return res.status(404).json({
        success: false,
        message: "Bucket not found",
      });
    }

    // =====================================================
    // ALREADY COMPLETED
    // =====================================================

    if (bucket.status === "Completed") {
      return res.status(400).json({
        success: false,
        message: "Bucket already completed",
      });
    }

    // =====================================================
    // GET ALL RELATED TASKS
    // =====================================================

    const relatedTasks = await Task.find({
      bucketId: bucket._id,
    }).select("assignedTo status completedAt title");

    // =====================================================
    // CHECK ALL TASKS COMPLETED
    // =====================================================

    const incompleteTasks = relatedTasks.filter(
      (task) => task.status !== "Completed",
    );

    if (incompleteTasks.length > 0) {
      return res.status(400).json({
        success: false,
        message: "All reporting user tasks must be completed first",
      });
    }

    // =====================================================
    // COMPLETE BUCKET
    // =====================================================

    bucket.status = "Completed";

    bucket.completedBy = userId;

    bucket.completedAt = new Date();

    bucket.remark = remark || "";

    await bucket.save();

    // =====================================================
    // COMPLETED USER
    // =====================================================

    const completedUser = await User.findById(userId).select("name email");

    // =====================================================
    // SEND EMAIL
    // =====================================================

    if (bucket.createdBy?.email) {
      const frontendUrl = `${process.env.BASE_URL}/delegate/bucket-view`;
      const emailTemplate = bucketCompletedTemplate({
        bucketId: bucket.bucketId,
        bucketTitle: bucket.title,
        completedBy: completedUser?.name,
        completedAt: new Date(bucket.completedAt).toLocaleString("en-IN"),
        remark,
        frontendUrl,
      });

      sendEmail({
        to: bucket.createdBy.email,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
      });
    }
      sendNotification({
        type: "BUCKET_COMPLETED",
        task: bucket,
        actor: completedUser,
        userId:bucket.createdBy._id
      });

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      success: true,
      message: "Bucket completed successfully",
      data: bucket,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to complete bucket",
    });
  }
};

export const getAllTaskBuckets = async (req, res) => {
  try {
    // =====================================================
    // QUERY PARAMS
    // =====================================================

    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.max(Number(req.query.limit) || 10, 1);

    const skip = (page - 1) * limit;

    const search = req.query.search?.trim() || "";

    const status = req.query.status?.trim() || "";

    // =====================================================
    // FILTER
    // =====================================================

    const filter = { isDeleted: false };

    // SEARCH
    if (search) {
      filter.$or = [
        {
          title: {
            $regex: search,
            $options: "i",
          },
        },

        {
          description: {
            $regex: search,
            $options: "i",
          },
        },

        {
          bucketId: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    // STATUS FILTER
    if (status && status !== "all") {
      filter.status = status;
    }

    // =====================================================
    // TOTAL COUNT
    // =====================================================

    const total = await TaskBucket.countDocuments(filter);

    // =====================================================
    // FETCH DATA
    // =====================================================

    const buckets = await TaskBucket.find(filter)
      // CREATED BY
      .populate({
        path: "createdBy",
        select: "name email",
      })

      // ROLE
      .populate({
        path: "targetRole",
        select: "name",
      })

      // TARGET USERS
      .populate({
        path: "targetUsers",
        select: "name email employeeId",
      })

      // ASSIGNED TARGET USERS
      .populate({
        path: "assignedTargetUsers",
        select: "name email employeeId",
      })

      // TARGET USER DISTRIBUTION USERS
      .populate({
        path: "targetUserDistribution.user",
        select: "name email employeeId",
      })

      // GENERATED TASKS
      .populate({
        path: "generatedTasks",
        select: "taskId title status assignedTo createdAt completedAt dueDate",
        populate: {
          path: "assignedTo",
          select: "name email employeeId",
        },
      })

      // COMPLETED BY
      .populate({
        path: "completedBy",
        select: "name email employeeId",
      })

      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // =====================================================
    // EXTRA FORMATTED DATA
    // =====================================================

    const formattedBuckets = buckets.map((bucket) => {
      const totalUsers =
        bucket.assignmentMode === "Users"
          ? bucket.targetUsers?.length || 0
          : bucket.assignedTargetUsers?.length || 0;

      const distributedUsers =
        bucket.targetUserDistribution?.filter((u) => u.status === "Distributed")
          .length || 0;

      return {
        ...bucket,

        totalUsers,

        distributedUsers,

        pendingUsers: totalUsers - distributedUsers,
      };
    });

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      success: true,

      message: "Task buckets fetched successfully",

      pagination: {
        total,

        page,

        limit,

        totalPages: Math.ceil(total / limit),

        hasNextPage: page * limit < total,

        hasPrevPage: page > 1,
      },

      data: formattedBuckets,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,

      message: err.message || "Failed to fetch task buckets",
    });
  }
};
export const updateTaskBucket = async (req, res) => {
  try {
    const { id } = req.params;

    // =====================================================
    // FIND BUCKET
    // =====================================================

    const existingBucket = await TaskBucket.findById(id);

    if (!existingBucket) {
      return res.status(404).json({
        success: false,
        message: "Task bucket not found",
      });
    }

    // =====================================================
    // BLOCK UPDATE IF COMPLETED
    // =====================================================

    if (existingBucket.status === "Completed") {
      return res.status(400).json({
        success: false,
        message: "Completed bucket cannot be updated",
      });
    }

    // =====================================================
    // BODY
    // =====================================================

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

      remark,
    } = req.body;

    // =====================================================
    // BOOLEAN FIX
    // =====================================================

    const dependentEnabled = String(isDependent) === "true";

    const recurrentEnabled = String(isRecurrent) === "true";

    // =====================================================
    // VALIDATION
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

    // =====================================================
    // USERS
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
    // FILES
    // =====================================================

    let uploadedFiles = existingBucket.attachmentFile || [];

    if (req.files?.length > 0) {
      const newFiles = req.files.map(
        (file) => `${req.uploadFolder}/${file.filename}`,
      );

      uploadedFiles = [...uploadedFiles, ...newFiles];
    }

    // =====================================================
    // DISTRIBUTION USERS
    // =====================================================

    let distributionUsers = [];

    let assignedUsers = [];

    if (assignmentMode === "Users") {
      distributionUsers = parsedUsers.map((u) => ({
        user: u,
        status: "Pending",
        distributedAt: null,
      }));

      assignedUsers = parsedUsers;
    }

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
    // UPDATE DATA
    // =====================================================

    existingBucket.title = title.trim();

    existingBucket.description = description.trim();

    existingBucket.assignmentMode = assignmentMode;

    existingBucket.targetRole = assignmentMode === "Role" ? targetRole : null;

    existingBucket.targetUsers = assignmentMode === "Users" ? parsedUsers : [];

    existingBucket.assignedTargetUsers = assignedUsers;

    existingBucket.targetUserDistribution = distributionUsers;

    existingBucket.startDate =
      !dependentEnabled && startDate ? startDate : null;

    existingBucket.taskEndDays =
      !recurrentEnabled && taskEndDays ? Number(taskEndDays) : null;

    existingBucket.checklist = checklist ? JSON.parse(checklist) : [];

    // =====================================================
    // DEPENDENCY
    // =====================================================

    existingBucket.isDependent = dependentEnabled;

    existingBucket.dependencyConfig = dependentEnabled
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
        };

    // =====================================================
    // RECURRENCE
    // =====================================================

    existingBucket.isRecurrent = recurrentEnabled;

    existingBucket.frequency = recurrentEnabled ? frequency : null;

    existingBucket.weekDays =
      recurrentEnabled && weekDays ? JSON.parse(weekDays) : [];

    existingBucket.endDate = recurrentEnabled && endDate ? endDate : null;

    // =====================================================
    // FILES
    // =====================================================

    existingBucket.attachmentFile = uploadedFiles;

    // =====================================================
    // REMARK
    // =====================================================

    existingBucket.remark = remark || "";

    // =====================================================
    // RESET STATUS
    // =====================================================

    existingBucket.distributionStatus = "Pending";

    // =====================================================
    // SAVE
    // =====================================================

    await existingBucket.save();

    // =====================================================
    // POPULATE
    // =====================================================

    await existingBucket.populate([
      {
        path: "createdBy",
        select: "name email",
      },
      {
        path: "targetUsers",
        select: "name email",
      },
      {
        path: "targetRole",
        select: "name",
      },
    ]);

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      success: true,
      message: "Task bucket updated successfully",
      data: existingBucket,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update task bucket",
    });
  }
};
