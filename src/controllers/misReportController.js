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
  // Normalize Inputs
  // =========================
  if (memberIds === "all" || !Array.isArray(memberIds)) {
    memberIds = [];
  }

  if (srManagerId === "all") srManagerId = null;
  if (managerId === "all") managerId = null;
  if (departmentId === "all") departmentId = null;

  const { start, end } = getDateRange(period, startDate, endDate);

  // =========================
  // User Filters
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
  // Base Match
  // =========================
  const matchCondition = {
    isDeleted: { $ne: true },
    taskType: { $ne: "RecurringTask" },
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

  if (departmentId) {
    matchCondition.departmentOfAssignToUser = new mongoose.Types.ObjectId(
      departmentId,
    );
  }

  // =========================
  // Dashboard Summary
  // =========================
  const summary = await Task.aggregate([
    {
      $match: matchCondition,
    },

    {
      $group: {
        _id: null,

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
                $and: [
                  { $ne: ["$status", "Completed"] },
                  { $lt: ["$dueDate", new Date()] },
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
                $and: [
                  { $eq: ["$status", "Completed"] },
                  { $gt: ["$completedAt", "$dueDate"] },
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
                  { $lte: ["$completedAt", "$dueDate"] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  // =========================
  // User Wise MIS Report
  // =========================
  const reports = await Task.aggregate([
    {
      $match: matchCondition,
    },

    {
      $group: {
        _id: "$assignedTo",

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
                $and: [
                  { $ne: ["$status", "Completed"] },
                  { $lt: ["$dueDate", new Date()] },
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
                $and: [
                  { $eq: ["$status", "Completed"] },
                  { $gt: ["$completedAt", "$dueDate"] },
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
                  { $lte: ["$completedAt", "$dueDate"] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },

    // =========================
    // User Join
    // =========================
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user",
      },
    },

    {
      $unwind: "$user",
    },

    // =========================
    // Role Join
    // =========================
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

    // =========================
    // Department Join
    // =========================
    {
      $lookup: {
        from: "departments",
        localField: "user.department",
        foreignField: "_id",
        as: "departments",
      },
    },

    // =========================
    // Calculations
    // =========================
    // {
    //   $addFields: {
    //     // =========================
    //     // TOTAL COMPLETION RATE
    //     // completed / total
    //     // =========================
    //     completionRate: {
    //       $round: [
    //         {
    //           $multiply: [
    //             {
    //               $divide: [
    //                 "$completed",
    //                 {
    //                   $cond: [{ $eq: ["$totalTasks", 0] }, 1, "$totalTasks"],
    //                 },
    //               ],
    //             },
    //             100,
    //           ],
    //         },
    //         2,
    //       ],
    //     },

    //     // =========================
    //     // ON TIME COMPLETION RATE
    //     // doneOnTime / completed
    //     // =========================
    //     onTimeCompletionRate: {
    //       $round: [
    //         {
    //           $multiply: [
    //             {
    //               $divide: [
    //                 "$doneOnTime",
    //                 {
    //                   $cond: [{ $eq: ["$completed", 0] }, 1, "$completed"],
    //                 },
    //               ],
    //             },
    //             100,
    //           ],
    //         },
    //         2,
    //       ],
    //     },

    //     // =========================
    //     // DELAYED COMPLETION RATE
    //     // delayed / completed
    //     // =========================
    //     delayedCompletionRate: {
    //       $round: [
    //         {
    //           $multiply: [
    //             {
    //               $divide: [
    //                 "$delayed",
    //                 {
    //                   $cond: [{ $eq: ["$completed", 0] }, 1, "$completed"],
    //                 },
    //               ],
    //             },
    //             100,
    //           ],
    //         },
    //         2,
    //       ],
    //     },

    //     // =========================
    //     // OVERDUE RATE
    //     // overdue / total
    //     // =========================
    //     overdueRate: {
    //       $round: [
    //         {
    //           $multiply: [
    //             {
    //               $divide: [
    //                 "$overdue",
    //                 {
    //                   $cond: [{ $eq: ["$totalTasks", 0] }, 1, "$totalTasks"],
    //                 },
    //               ],
    //             },
    //             100,
    //           ],
    //         },
    //         2,
    //       ],
    //     },
    //   },
    // },
    {
      $addFields: {
        completionRate: {
          $round: [
            {
              $subtract: [
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
                100,
              ],
            },
            2,
          ],
        },

        onTimeCompletionRate: {
          $round: [
            {
              $subtract: [
                {
                  $multiply: [
                    {
                      $divide: [
                        "$doneOnTime",
                        {
                          $cond: [{ $eq: ["$completed", 0] }, 1, "$completed"],
                        },
                      ],
                    },
                    100,
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
              $subtract: [
                {
                  $multiply: [
                    {
                      $divide: [
                        "$delayed",
                        {
                          $cond: [{ $eq: ["$completed", 0] }, 1, "$completed"],
                        },
                      ],
                    },
                    100,
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
              $subtract: [
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
                100,
              ],
            },
            2,
          ],
        },
      },
    },
    // =========================
    // Final Response
    // =========================
    {
      $project: {
        _id: 0,

        userId: "$user._id",
        userName: "$user.name",
        email: "$user.email",

        role: {
          $ifNull: ["$role.name", "Unknown"],
        },

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
  ]);

  // =========================
  // Top Performers
  // =========================
  const topPerformers = reports.filter((u) => u.completionRate > 0).slice(0, 5);

  // =========================
  // Bottom Performers
  // =========================
  const lowPerformers = [...reports]
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, 5);

  // =========================
  // Task List
  // =========================
  const filteredTasks = await Task.find(matchCondition)
    .select(
      `
      TaskId
      title
      status
      taskType
      startDate
      dueDate
      endDate
      completedAt
    `,
    )
    .populate("assignedTo", "name email")
    .populate("createdBy", "name")
    .populate("departmentOfAssignToUser", "name")
    .sort({ createdAt: -1 })
    .lean();

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

    summary: summary[0] || {
      totalTasks: 0,
      completed: 0,
      pending: 0,
      upcoming: 0,
      overdue: 0,
      delayed: 0,
      doneOnTime: 0,
    },

    topPerformers,

    lowPerformers,

    count: reports.length,

    reports,

    // tasks: filteredTasks,
  });
});
