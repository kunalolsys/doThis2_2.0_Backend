import mongoose from "mongoose";
import Task from "../models/Task.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import { getDateRange } from "../utils/reportHelpers.js";

export const getMisReport = handleAsync(async (req, res, next) => {
  let {
    period,
    startDate,
    endDate,
    srManagerId,
    managerId,
    departmentId,
    memberIds,
  } = req.body;

  // =========================
  // 1. Normalize Inputs
  // =========================
  if (memberIds === "all" || !Array.isArray(memberIds)) {
    memberIds = [];
  }

  if (srManagerId === "all") srManagerId = null;
  if (managerId === "all") managerId = null;
  if (departmentId === "all") departmentId = null;

  const { start, end } = getDateRange(period, startDate, endDate);

  // =========================
  // 2. User Filters
  // =========================
  const userIds = new Set(memberIds || []);

  if (managerId) userIds.add(managerId);
  if (srManagerId) userIds.add(srManagerId);

  const userIdArray = [...userIds]
    .map((id) =>
      mongoose.Types.ObjectId.isValid(id)
        ? new mongoose.Types.ObjectId(id)
        : null,
    )
    .filter(Boolean);

  // =========================
  // 3. Base Match Condition
  // =========================
  const matchCondition = {
    isDeleted: { $ne: true },
    taskType: { $ne: "RecurringTask" }, // Only single/delegated instance tasks
    $or: [
      {
        dueDate: {
          $ne: null,
          $gte: start,
          $lte: end,
        },
      },
      {
        endDate: {
          $ne: null,
          $gte: start,
          $lte: end,
        },
      },
      {
        startDate: {
          $ne: null,
          $gte: start,
          $lte: end,
        },
      },
    ],
  };

  if (userIdArray.length > 0) {
    matchCondition.assignedTo = { $in: userIdArray };
  }

  if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
    matchCondition.departmentOfAssignToUser = new mongoose.Types.ObjectId(
      departmentId,
    );
  }

  const now = new Date();

  // Shared Group Expression for Counts
  const groupExpression = {
    totalTasks: { $sum: 1 },

    completed: {
      $sum: {
        $cond: [{ $eq: ["$status", "Completed"] }, 1, 0],
      },
    },

    pending: {
      $sum: {
        $cond: [{ $eq: ["$status", "Pending"] }, 1, 0],
      },
    },

    upcoming: {
      $sum: {
        $cond: [{ $eq: ["$status", "Upcoming"] }, 1, 0],
      },
    },

    overdue: {
      $sum: {
        $cond: [
          {
            $or: [
              { $eq: ["$status", "Overdue"] },
              {
                $and: [
                  { $ne: ["$status", "Completed"] },
                  { $ne: ["$dueDate", null] },
                  { $lt: ["$dueDate", now] },
                ],
              },
            ],
          },
          1,
          0,
        ],
      },
    },

    delayed: {
      $sum: {
        $cond: [
          {
            $or: [
              { $eq: ["$status", "Delayed"] },
              {
                $and: [
                  { $eq: ["$status", "Completed"] },
                  { $ne: ["$completedAt", null] },
                  { $ne: ["$dueDate", null] },
                  { $gt: ["$completedAt", "$dueDate"] },
                ],
              },
            ],
          },
          1,
          0,
        ],
      },
    },

    doneOnTime: {
      $sum: {
        $cond: [
          {
            $and: [
              { $eq: ["$status", "Completed"] },
              { $ne: ["$completedAt", null] },
              { $ne: ["$dueDate", null] },
              { $lte: ["$completedAt", "$dueDate"] },
            ],
          },
          1,
          0,
        ],
      },
    },
  };

  // =========================================================
  // 4. Combined Aggregation via $facet
  // =========================================================
  const aggregationResult = await Task.aggregate([
    { $match: matchCondition },
    {
      $facet: {
        // SUMMARY BRANCH
        summary: [{ $group: { _id: null, ...groupExpression } }],

        // USER-WISE REPORTS BRANCH
        reports: [
          { $group: { _id: "$assignedTo", ...groupExpression } },
          {
            $lookup: {
              from: "users",
              localField: "_id",
              foreignField: "_id",
              as: "user",
            },
          },
          { $unwind: "$user" },
          {
            $lookup: {
              from: "roles",
              localField: "user.role",
              foreignField: "_id",
              as: "role",
            },
          },
          {
            $unwind: {
              path: "$role",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $lookup: {
              from: "departments",
              localField: "user.department",
              foreignField: "_id",
              as: "departments",
            },
          },

          // CALCULATE PERCENTAGE RATES CORRECTLY
          {
            $addFields: {
              completionRate: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          "$completed",
                          {
                            $cond: [
                              { $eq: ["$totalTasks", 0] },
                              1,
                              "$totalTasks",
                            ],
                          },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },

              onTimeCompletionRate: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          "$doneOnTime",
                          {
                            $cond: [
                              { $eq: ["$completed", 0] },
                              1,
                              "$completed",
                            ],
                          },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },

              delayedCompletionRate: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          "$delayed",
                          {
                            $cond: [
                              { $eq: ["$completed", 0] },
                              1,
                              "$completed",
                            ],
                          },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },

              overdueRate: {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: [
                          "$overdue",
                          {
                            $cond: [
                              { $eq: ["$totalTasks", 0] },
                              1,
                              "$totalTasks",
                            ],
                          },
                        ],
                      },
                      100,
                    ],
                  },
                  2,
                ],
              },
            },
          },

          // PROJECT CLEAN OUTPUT
          {
            $project: {
              _id: 0,
              userId: "$user._id",
              userName: "$user.name",
              email: "$user.email",
              role: { $ifNull: ["$role.name", "Unknown"] },
              departments: "$departments.name",

              totalTasks: 1,
              completed: 1,
              pending: 1,
              upcoming: 1,
              overdue: 1,
              delayed: 1,
              doneOnTime: 1,

              completionRate: 1,
              onTimeCompletionRate: 1,
              delayedCompletionRate: 1,
              overdueRate: 1,
            },
          },

          {
            $sort: {
              completionRate: -1,
              doneOnTime: -1,
              totalTasks: -1,
            },
          },
        ],
      },
    },
  ]);

  const summaryData = aggregationResult[0]?.summary[0] || {
    totalTasks: 0,
    completed: 0,
    pending: 0,
    upcoming: 0,
    overdue: 0,
    delayed: 0,
    doneOnTime: 0,
  };

  const reports = aggregationResult[0]?.reports || [];

  // =========================
  // Top & Low Performers
  // =========================
  const topPerformers = reports.filter((u) => u.completionRate > 0).slice(0, 5);

  const lowPerformers = [...reports]
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, 5);

  // =========================
  // Response
  // =========================
  res.status(200).json({
    success: true,

    filters: {
      period,
      startDate,
      endDate,
      srManagerId,
      managerId,
      departmentId,
      memberCount: memberIds.length,
    },

    dateRange: {
      start: start.toISOString(),
      end: end.toISOString(),
    },

    summary: summaryData,
    topPerformers,
    lowPerformers,

    count: reports.length,
    reports,
  });
});
