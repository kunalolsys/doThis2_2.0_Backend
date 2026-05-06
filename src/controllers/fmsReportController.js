import mongoose from "mongoose";
import { handleAsync } from "../utils/handleAsync.js";
import { getDateRange } from "../utils/reportHelpers.js";
import AppError from "../utils/AppError.js";

import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsInstance from "../models/FmsInstance.js";

// Keep controller focused: remove unused helper imports/vars when not used.


const safeObjectId = (id) => {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
};

// Define "on time" for FMS as: completed on/before plannedDueDate.
// late as: completed after plannedDueDate.
const buildTaskMatch = ({ start, end, instanceId, templateId, status }) => {
  const match = {
    isVisible: true,
  };

  // Time window: use plannedDueDate if available, else actualCompleteDate.
  match.$or = [
    { plannedDueDate: { $ne: null, $gte: start, $lte: end } },
    { actualCompleteDate: { $ne: null, $gte: start, $lte: end } },
  ];

  if (instanceId) match.fmsInstanceId = instanceId;
  if (templateId) match.fmsTemplateId = templateId; // may be null/not present

  if (status && ["upcoming", "ongoing", "completed", "onhold", "stopped"].includes(status)) {
    // In instance model statuses.
    // We don't have instance.status in this collection, so we will filter later via lookup.
    // Keeping here as a marker.
    match.__instanceStatus = status;
  }

  return match;
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

  // normalize
  if (memberIds === "all" || !Array.isArray(memberIds)) memberIds = [];

  const instanceObjectId = safeObjectId(instanceId);
  const templateObjectId = safeObjectId(templateId);

  let managerObjectId = safeObjectId(managerId);
  let srManagerObjectId = safeObjectId(srManagerId);

  const userIdSet = new Set();
  if (Array.isArray(memberIds)) {
    for (const id of memberIds) {
      const objId = safeObjectId(id);
      if (objId) userIdSet.add(objId.toString());
    }
  }
  if (managerObjectId) userIdSet.add(managerObjectId.toString());
  if (srManagerObjectId) userIdSet.add(srManagerObjectId.toString());

  const userIdArray = [...userIdSet].map((id) => new mongoose.Types.ObjectId(id));

  const { start, end } = getDateRange(period, startDate, endDate);

  if (!start || !end) return next(new AppError("Invalid date range", 400));

  // We will compute summary from FmsInstanceTask and optionally filter by instance status via lookup.
  const baseMatch = {
    isVisible: true,
    $or: [
      { plannedDueDate: { $ne: null, $gte: start, $lte: end } },
      { actualCompleteDate: { $ne: null, $gte: start, $lte: end } },
    ],
  };

  if (instanceObjectId) baseMatch.fmsInstanceId = instanceObjectId;

  if (userIdArray.length > 0) {
    baseMatch.assignedTo = { $in: userIdArray };
  }

  // Aggregation pipeline
  const pipeline = [
    { $match: baseMatch },

    // Only completed tasks should contribute to on-time/late scoring.
    // This fixes cases where a task marked "Overdue/Pending" but not completed
    // was counted as notDoneOnTime.
    {
      $match: { status: "Completed", actualCompleteDate: { $ne: null } },
    },

    // join instance for status filtering and metadata
    {
      $lookup: {
        from: "fmsinstances",
        localField: "fmsInstanceId",
        foreignField: "_id",
        as: "instance",
      },
    },
    { $unwind: { path: "$instance", preserveNullAndEmptyArrays: false } },

    // optional instance status filter
    ...(instanceStatus && ["upcoming", "ongoing", "completed", "onhold", "stopped"].includes(String(instanceStatus).toLowerCase())
      ? [
          {
            $match: {
              "instance.status": (() => {
                const s = String(instanceStatus).toLowerCase();
                const map = {
                  upcoming: "Upcoming",
                  ongoing: { $in: ["Ongoing", "InProcess"] },
                  completed: { $in: ["Completed", "Cancelled"] },
                  onhold: { $in: ["Onhold"] },
                  stopped: { $in: ["Stopped"] },
                };
                return map[s];
              })(),
            },
          },
        ]
      : []),

    {
      $group: {
        _id: "$assignedTo",
        totalTasks: { $sum: 1 },
        doneOnTime: {
          $sum: {
            $cond: [
              {
                $and: [
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
                  { $ne: ["$actualCompleteDate", null] },
                  { $gt: ["$actualCompleteDate", "$plannedDueDate"] },
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
    { $match: { score: { $gt: 0 } } },
    { $sort: { score: -1, totalTasks: -1 } },
    { $limit: 3 },

    // enrich user + role
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
        notDone: 1,
        score: 1,
        lateScore: 1,
      },
    },
  ];

  const topPerformers = await FmsInstanceTask.aggregate(pipeline);

  // Template-wise summary for cleaner UI: group by FMS template (via FmsInstance -> fmsTemplateId)
  // Assumption (scope): tasks where user is the assignee (FmsInstanceTask.assignedTo)
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
    ...(instanceStatus &&
    ["upcoming", "ongoing", "completed", "onhold", "stopped"].includes(String(instanceStatus).toLowerCase())
      ? [
          {
            $match: {
              "instance.status": (() => {
                const s = String(instanceStatus).toLowerCase();
                const map = {
                  upcoming: "Upcoming",
                  ongoing: { $in: ["Ongoing", "InProcess"] },
                  completed: { $in: ["Completed", "Cancelled"] },
                  onhold: { $in: ["Onhold"] },
                  stopped: { $in: ["Stopped"] },
                };
                return map[s];
              })(),
            },
          },
        ]
      : []),
    ...(templateObjectId
      ? [{ $match: { "instance.fmsTemplateId": templateObjectId } }]
      : []),

    {
      $group: {
        _id: "$instance.fmsTemplateId",
        assigned: { $sum: 1 },
        completed: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ["$actualCompleteDate", null] }, { $eq: ["$status", "Completed"] }] },
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
                  { $ne: ["$actualCompleteDate", null] },
                  { $eq: ["$status", "Completed"] },
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
                  { $ne: ["$actualCompleteDate", null] },
                  { $eq: ["$status", "Completed"] },
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
                  $divide: ["$completed", { $cond: [{ $eq: ["$assigned", 0] }, 1, "$assigned"] }],
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
                  $divide: ["$onTime", { $cond: [{ $eq: ["$completed", 0] }, 1, "$completed"] }],
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
                  $divide: ["$late", { $cond: [{ $eq: ["$completed", 0] }, 1, "$completed"] }],
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
        templateName: "$template.templateName",
        fmsId: "$template.fmsId",
        assigned: 1,
        completed: 1,
        onTime: 1,
        late: 1,
        completionRate: 1,
        onTimeRate: 1,
        lateRate: 1,
      },
    },
    { $sort: { completionRate: -1, completed: -1 } },
  ];

  const templateStats = await FmsInstanceTask.aggregate(templatePipeline);

  // Detailed tasks list (non-aggregated, with pagination)
  const skip = (Number(page) - 1) * Number(limit);

  // instance status filter for detailed list: derive from FmsInstance
  let instanceFilter = {};
  if (instanceStatus && ["upcoming", "ongoing", "completed", "onhold", "stopped"].includes(String(instanceStatus).toLowerCase())) {
    const s = String(instanceStatus).toLowerCase();
    const instanceMap = {
      upcoming: ["Upcoming"],
      ongoing: ["Ongoing", "InProcess"],
      completed: ["Completed", "Cancelled"],
      onhold: ["Onhold"],
      stopped: ["Stopped"],
    };
    const statuses = instanceMap[s];
    const instances = await FmsInstance.find({ status: { $in: statuses } }).select("_id").lean();
    const ids = instances.map((i) => i._id);
    instanceFilter = { ...(ids.length ? { fmsInstanceId: { $in: ids } } : { fmsInstanceId: null }) };
  }

  const detailMatch = {
    ...baseMatch,
    ...instanceFilter,
  };

  if (templateObjectId) {
    // Apply template filter using join to instances IDs
    const instances = await FmsInstance.find({ fmsTemplateId: templateObjectId }).select("_id").lean();
    const ids = instances.map((i) => i._id);
    detailMatch.fmsInstanceId = ids.length ? { $in: ids } : { $in: [null] };
  }

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
      pages: Math.ceil(total / Number(limit)),
      total,
      limit: Number(limit),
    },
  });
});

