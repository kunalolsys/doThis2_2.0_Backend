import mongoose from "mongoose";
import { handleAsync } from "../utils/handleAsync.js";
import { getDateRange } from "../utils/reportHelpers.js";
import AppError from "../utils/AppError.js";

import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsInstance from "../models/FmsInstance.js";

const safeObjectId = (id) => {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id)
    ? new mongoose.Types.ObjectId(id)
    : null;
};

export const getFmsReport = handleAsync(async (req, res, next) => {
  let {
    period,
    startDate,
    endDate,
    managerId,
    srManagerId,
    memberIds,
    instanceId,
    instanceStatus,
    templateId,
    limit = 10,
    page = 1,
  } = req.body;

  // Normalize memberIds
  if (memberIds === "all" || !Array.isArray(memberIds)) memberIds = [];

  const instanceObjectId = safeObjectId(instanceId);
  const templateObjectId = safeObjectId(templateId);
  const managerObjectId = safeObjectId(managerId);
  const srManagerObjectId = safeObjectId(srManagerId);

  const userIdSet = new Set();
  if (Array.isArray(memberIds)) {
    for (const id of memberIds) {
      const objId = safeObjectId(id);
      if (objId) userIdSet.add(objId.toString());
    }
  }
  if (managerObjectId) userIdSet.add(managerObjectId.toString());
  if (srManagerObjectId) userIdSet.add(srManagerObjectId.toString());

  const userIdArray = [...userIdSet].map(
    (id) => new mongoose.Types.ObjectId(id),
  );

  const { start, end } = getDateRange(period, startDate, endDate);

  if (!start || !end) return next(new AppError("Invalid date range", 400));

  const now = new Date();

  // 🟢 1. BASE MATCH (Includes tasks with planned dates OR created in range)
  const baseMatch = {
    $or: [
      { plannedDueDate: { $gte: start, $lte: end } },
      { plannedStartDate: { $gte: start, $lte: end } },
      { actualCompleteDate: { $gte: start, $lte: end } },
      { createdAt: { $gte: start, $lte: end } }, // 👈 Missing start/end dates vaale tasks bhi count honge
    ],
  };

  if (userIdArray.length > 0) {
    baseMatch.assignedTo = { $in: userIdArray };
  }

  // Instance & Template filters
  if (instanceObjectId) {
    baseMatch.fmsInstanceId = instanceObjectId;
  } else if (templateObjectId) {
    const matchingInstances = await FmsInstance.find({
      fmsTemplateId: templateObjectId,
    })
      .select("_id")
      .lean();

    const instanceIds = matchingInstances.map((i) => i._id);
    baseMatch.fmsInstanceId = instanceIds.length
      ? { $in: instanceIds }
      : { $in: [new mongoose.Types.ObjectId()] };
  }

  const getInstanceStatusMatch = () => {
    if (
      !instanceStatus ||
      !["upcoming", "ongoing", "completed", "onhold", "stopped"].includes(
        String(instanceStatus).toLowerCase(),
      )
    ) {
      return null;
    }

    const s = String(instanceStatus).toLowerCase();
    const map = {
      upcoming: "Upcoming",
      ongoing: { $in: ["Ongoing", "InProcess"] },
      completed: { $in: ["Completed", "Cancelled"] },
      onhold: { $in: ["Onhold"] },
      stopped: { $in: ["Stopped"] },
    };

    return { $match: { "instance.status": map[s] } };
  };

  const statusMatchStage = getInstanceStatusMatch();

  // 🟢 2. TOP PERFORMERS AGGREGATION PIPELINE
  const pipeline = [
    { $match: baseMatch },
    {
      $lookup: {
        from: "fmsinstances",
        localField: "fmsInstanceId",
        foreignField: "_id",
        as: "instance",
      },
    },
    { $unwind: { path: "$instance", preserveNullAndEmptyArrays: false } },
  ];

  if (statusMatchStage) {
    pipeline.push(statusMatchStage);
  }

  pipeline.push(
    {
      $group: {
        _id: "$assignedTo",
        totalTasks: { $sum: 1 },
        doneOnTime: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$status", "Completed"] },
                  { $ne: ["$actualCompleteDate", null] },
                  { $lte: ["$actualCompleteDate", "$plannedDueDate"] },
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
                  { $eq: ["$status", "Completed"] },
                  { $ne: ["$actualCompleteDate", null] },
                  { $gt: ["$actualCompleteDate", "$plannedDueDate"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        // 🟢 ACCURATE OVERDUE (Strictly checks plannedDueDate != null and not pending)
        overdueCount: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$status", "Overdue"] },
                  {
                    $and: [
                      { $ne: ["$plannedDueDate", null] },
                      { $lt: ["$plannedDueDate", now] },
                      {
                        $not: {
                          $in: ["$status", ["Completed", "Stopped", "Not Done"]],
                        },
                      },
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
        // 🟢 PENDING / WAITING TASKS (Without dates)
        pendingCount: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$status", "Pending"] },
                  { $eq: ["$waitingForParent", true] },
                ],
              },
              1,
              0,
            ],
          },
        },
        notDone: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$actualCompleteDate", null] },
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
    { $sort: { score: -1, doneOnTime: -1, totalTasks: -1 } },
    { $limit: 10 },
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
      $unwind: { path: "$role", preserveNullAndEmptyArrays: true },
    },
    {
      $project: {
        _id: 0,
        userId: "$user._id",
        userName: "$user.name",
        role: { $ifNull: ["$role.name", "Unknown"] },
        totalTasks: 1,
        doneOnTime: 1,
        notDoneOnTime: 1,
        overdueCount: 1,
        pendingCount: 1,
        notDone: 1,
        score: 1,
        lateScore: 1,
      },
    },
  );

  const topPerformers = await FmsInstanceTask.aggregate(pipeline);

  // 🟢 3. TEMPLATE-WISE SUMMARY PIPELINE
  const templatePipeline = [
    { $match: baseMatch },
    {
      $lookup: {
        from: "fmsinstances",
        localField: "fmsInstanceId",
        foreignField: "_id",
        as: "instance",
      },
    },
    { $unwind: { path: "$instance", preserveNullAndEmptyArrays: false } },
  ];

  if (statusMatchStage) {
    templatePipeline.push(statusMatchStage);
  }

  templatePipeline.push(
    {
      $group: {
        _id: "$instance.fmsTemplateId",
        assigned: { $sum: 1 },
        completed: {
          $sum: {
            $cond: [{ $eq: ["$status", "Completed"] }, 1, 0],
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
                      { $ne: ["$plannedDueDate", null] },
                      { $lt: ["$plannedDueDate", now] },
                      {
                        $not: {
                          $in: ["$status", ["Completed", "Stopped", "Not Done"]],
                        },
                      },
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
        pending: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$status", "Pending"] },
                  { $eq: ["$waitingForParent", true] },
                ],
              },
              1,
              0,
            ],
          },
        },
        onTime: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$status", "Completed"] },
                  { $ne: ["$actualCompleteDate", null] },
                  { $lte: ["$actualCompleteDate", "$plannedDueDate"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        late: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$status", "Completed"] },
                  { $ne: ["$actualCompleteDate", null] },
                  { $gt: ["$actualCompleteDate", "$plannedDueDate"] },
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
        completionRate: {
          $round: [
            {
              $multiply: [
                {
                  $divide: [
                    "$completed",
                    { $cond: [{ $eq: ["$assigned", 0] }, 1, "$assigned"] },
                  ],
                },
                100,
              ],
            },
            2,
          ],
        },
        onTimeRate: {
          $round: [
            {
              $multiply: [
                {
                  $divide: [
                    "$onTime",
                    { $cond: [{ $eq: ["$completed", 0] }, 1, "$completed"] },
                  ],
                },
                100,
              ],
            },
            2,
          ],
        },
        lateRate: {
          $round: [
            {
              $multiply: [
                {
                  $divide: [
                    "$late",
                    { $cond: [{ $eq: ["$completed", 0] }, 1, "$completed"] },
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
    {
      $lookup: {
        from: "fmstemplates",
        localField: "_id",
        foreignField: "_id",
        as: "template",
      },
    },
    { $unwind: { path: "$template", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        fmsTemplateId: "$_id",
        templateName: {
          $ifNull: ["$template.templateName", "Unknown Template"],
        },
        fmsId: { $ifNull: ["$template.fmsId", "—"] },
        assigned: 1,
        completed: 1,
        overdue: 1,
        pending: 1,
        onTime: 1,
        late: 1,
        completionRate: 1,
        onTimeRate: 1,
        lateRate: 1,
      },
    },
    { $sort: { completionRate: -1, completed: -1 } },
  );

  const templateStats = await FmsInstanceTask.aggregate(templatePipeline);

  // 4. DETAILED PAGINATED TASK LIST
  const skip = (Number(page) - 1) * Number(limit);

  let instanceFilter = {};
  if (
    instanceStatus &&
    ["upcoming", "ongoing", "completed", "onhold", "stopped"].includes(
      String(instanceStatus).toLowerCase(),
    )
  ) {
    const s = String(instanceStatus).toLowerCase();
    const instanceMap = {
      upcoming: ["Upcoming"],
      ongoing: ["Ongoing", "InProcess"],
      completed: ["Completed", "Cancelled"],
      onhold: ["Onhold"],
      stopped: ["Stopped"],
    };
    const statuses = instanceMap[s];
    const instances = await FmsInstance.find({ status: { $in: statuses } })
      .select("_id")
      .lean();
    const ids = instances.map((i) => i._id);
    instanceFilter = {
      fmsInstanceId: ids.length
        ? { $in: ids }
        : { $in: [new mongoose.Types.ObjectId()] },
    };
  }

  const detailMatch = {
    ...baseMatch,
    ...instanceFilter,
  };

  const tasks = await FmsInstanceTask.find(detailMatch)
    .sort({ plannedDueDate: 1, taskId: 1 })
    .skip(skip)
    .limit(Number(limit))
    .populate({
      path: "fmsInstanceId",
      select: "instanceName status startDate endDate fmsTemplateId",
    })
    .populate({
      path: "assignedTo",
      select: "name email department assignShift",
      populate: { path: "assignShift", select: "_id" },
    })
    .populate({
      path: "assignedBy",
      select: "name email",
    })
    .populate({
      path: "departmentOfAssignToUser",
      select: "name",
    })
    .lean();

  const total = await FmsInstanceTask.countDocuments(detailMatch);

  res.status(200).json({
    success: true,
    count: tasks.length,
    total,
    topPerformers,
    templateStats,
    tasks,
    filters: {
      period,
      startDate,
      endDate,
      managerId,
      srManagerId,
      memberCount: memberIds?.length || 0,
      instanceId,
      instanceStatus: instanceStatus || null,
      templateId: templateId || null,
      page: Number(page),
      limit: Number(limit),
    },
    dateRange: {
      start: start.toISOString().split("T")[0],
      end: end.toISOString().split("T")[0],
    },
    pagination: {
      current: Number(page),
      pages: Math.ceil(total / Number(limit)) || 1,
      total,
      limit: Number(limit),
    },
  });
});