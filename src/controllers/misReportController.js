import mongoose from "mongoose";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import { getSubordinates, getDateRange } from "../utils/reportHelpers.js";

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

  // ✅ Normalize inputs
  if (memberIds === "all" || !Array.isArray(memberIds)) {
    memberIds = [];
  }

  if (srManagerId === "all") srManagerId = null;
  if (managerId === "all") managerId = null;

  // ✅ Date Range
  const { start, end } = getDateRange(period, startDate, endDate);

  // ✅ Simple userIds = selected manager/member/sr IDs
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

  // if (userIds.size === 0) {
  //   return next(new AppError("No users found for report", 400));
  // }
  const matchCondition = {
    // assignedTo: { $in: userIdArray },
    isDeleted: { $ne: true },
    isVisible: true,
    $or: [
      { dueDate: { $ne: null, $gte: start, $lte: end } },
      { endDate: { $ne: null, $gte: start, $lte: end } },
    ],
  };
  if (userIdArray.length > 0) {
    matchCondition.assignedTo = { $in: userIdArray };
  }
  const globalTopPerformers = await Task.aggregate([
    {
      $match: {
        isDeleted: { $ne: true },
        isVisible: true,
        $or: [
          { dueDate: { $ne: null, $gte: start, $lte: end } },
          { endDate: { $ne: null, $gte: start, $lte: end } },
        ],
      },
    },
    {
      $group: {
        _id: "$assignedTo",
        totalTasks: { $sum: 1 },
        doneOnTime: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$completedAt", null] },
                  { $lte: ["$completedAt", "$dueDate"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        notDoneOnTime: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$completedAt", null] },
                  { $gt: ["$completedAt", "$dueDate"] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $addFields: {
        score: {
          $round: [
            {
              $multiply: [
                {
                  $divide: [
                    "$doneOnTime",
                    { $cond: [{ $eq: ["$totalTasks", 0] }, 1, "$totalTasks"] },
                  ],
                },
                100,
              ],
            },
            2,
          ],
        },
        lateScore: {
          $round: [
            {
              $multiply: [
                {
                  $divide: [
                    "$notDoneOnTime",
                    { $cond: [{ $eq: ["$totalTasks", 0] }, 1, "$totalTasks"] },
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

    // ✅ ❗ REMOVE score = 0 performers
    {
      $match: {
        score: { $gt: 0 },
      },
    },

    { $sort: { score: -1, totalTasks: -1 } },
    { $limit: 3 },

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
      $project: {
        _id: 0,
        userId: "$user._id",
        name: "$user.name",
        totalTasks: 1,
        doneOnTime: 1,
        score: 1,
        lateScore: 1,
      },
    },
  ]);
  // ✅ Aggregation
  const reports = await Task.aggregate([
    {
      $match: matchCondition,
    },

    {
      $group: {
        _id: "$assignedTo",

        totalTasks: { $sum: 1 },

        // ✅ Done on time → completed AND before dueDate
        doneOnTime: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$completedAt", null] },
                  { $lte: ["$completedAt", "$dueDate"] },
                ],
              },
              1,
              0,
            ],
          },
        },

        // ❌ Not done on time → completed BUT late
        notDoneOnTime: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$completedAt", null] },
                  { $gt: ["$completedAt", "$dueDate"] },
                ],
              },
              1,
              0,
            ],
          },
        },

        // ⏳ Not done → not completed
        notDone: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$completedAt", null] },
                  { $ne: ["$status", "Completed"] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },

    // ✅ Join user
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },

    // ✅ Join role
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

    // ✅ Final projection
    {
      $project: {
        _id: 0,
        userId: "$user._id",
        userName: "$user.name",
        role: { $ifNull: ["$role.name", "Unknown"] },

        totalTasks: 1,
        doneOnTime: 1,
        notDoneOnTime: 1,
        notDone: 1,

        score: {
          $round: [
            {
              $multiply: [
                {
                  $divide: [
                    "$doneOnTime",
                    { $cond: [{ $eq: ["$totalTasks", 0] }, 1, "$totalTasks"] },
                  ],
                },
                100,
              ],
            },
            2,
          ],
        },
        lateScore: {
          $round: [
            {
              $multiply: [
                {
                  $divide: [
                    "$notDoneOnTime",
                    { $cond: [{ $eq: ["$totalTasks", 0] }, 1, "$totalTasks"] },
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

    { $sort: { score: -1, totalTasks: -1 } },
  ]);
  const filteredTasks = await Task.find(matchCondition)
    .select("_id title")
    .populate("assignedTo", "name email")
    .populate("createdBy", "name")
    .sort({ createdAt: -1 })
    .lean();
  //**filter top performer */
  // let finalTopPerformers = globalTopPerformers;

  // // 👉 If filters exist → keep only matching users
  // if (userIdArray.length > 0) {
  //   const userIdsSet = new Set(userIdArray.map((id) => id.toString()));

  //   finalTopPerformers = globalTopPerformers.filter((user) =>
  //     userIdsSet.has(user.userId.toString()),
  //   );
  // }
  // ✅ Response
  res.status(200).json({
    success: true,
    count: reports.length,
    data: reports,
    tasks: filteredTasks,
    topPerformers: globalTopPerformers,
    filters: {
      period,
      startDate,
      endDate,
      srManagerId,
      managerId,
      memberCount: memberIds.length,
    },
    dateRange: {
      start: start.toISOString().split("T")[0],
      end: end.toISOString().split("T")[0],
    },
  });
});
