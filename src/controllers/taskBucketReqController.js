import TaskBucketRequest from "../models/TaskBucketRequest.js";
import { handleAsync } from "../utils/handleAsync.js";

export const submitTaskBucketRequest = handleAsync(async (req, res) => {
  const request = await TaskBucketRequest.create({
    title: req.body.title,
    description: req.body.description,
    location: req.body.location,

    submittedBy: req.body.submittedBy,

    userAgent: req.headers["user-agent"] || "",
  });

  res.status(201).json({
    success: true,
    data: request,
  });
});
export const getTaskBucketRequests = handleAsync(async (req, res) => {
  const { status } = req.query;

  const filter = {};

  if (status) {
    filter.status = status;
  }

  const requests = await TaskBucketRequest.find(filter)
    .populate("convertedTaskBucket", "bucketId title")
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    count: requests.length,
    data: requests,
  });
});

export const updateTaskBucketRequest = handleAsync(async (req, res, next) => {
  const { id } = req.params;

  const request = await TaskBucketRequest.findById(id);

  if (!request) {
    return next(new AppError("Task Bucket Request not found", 404));
  }

  const updated = await TaskBucketRequest.findByIdAndUpdate(
    id,
    {
      ...req.body,
    },
    {
      new: true,
      runValidators: true,
    },
  );

  res.status(200).json({
    success: true,
    message: "Task Bucket Request updated successfully",
    data: updated,
  });
});
export const convertTaskBucketRequest = handleAsync(async (req, res, next) => {
  const { id } = req.params;

  const { taskBucketId, startDate, taskEndDays, attachmentFile } = req.body;

  const request = await TaskBucketRequest.findById(id);

  if (!request) {
    return next(new AppError("Task Bucket Request not found", 404));
  }

  request.status = "Converted";
  request.convertedTaskBucket = taskBucketId;

  request.startDate = startDate || request.startDate;
  request.taskEndDays = taskEndDays || request.taskEndDays;

  if (attachmentFile) {
    request.attachmentFile = attachmentFile;
  }

  await request.save();

  res.status(200).json({
    success: true,
    message: "Request converted successfully",
    data: request,
  });
});
