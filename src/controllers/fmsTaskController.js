import FmsTask from "../models/FmsTask.js";
import FmsTemplate from "../models/FmsTemplate.js";
import User from "../models/User.js";
import Department from "../models/Department.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import { createLog } from "./logController.js";

export const createFmsTasks = handleAsync(async (req, res, next) => {
  const { id: templateId } = req.params;
  let rows = Array.isArray(req.body) ? req.body : [req.body];

  const template = await FmsTemplate.findById(templateId).populate("manager");
  if (!template) return next(new AppError("Template not found", 404));

  const created = [];
  const errors = [];
  const createdTasksIds = []; // NEW: Track task IDs for template update

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isRecurrent = ["Daily", "Weekly", "Monthly", "Anytime"].includes(
      row.frequency,
    );
    try {
      const description = row.taskDescription?.trim();
      if (!description) throw new Error("taskDescription required");

      const taskData = {
        fmsTemplateId: template._id,
        description,
        departmentOfAssignToUser: row.department,
        assignedTo: row.doer,
        frequency: row.frequency,
        xValue: parseFloat(row.value || 0),
        isDependent: row["is it dependent?"] === "Yes" || false,
        dependentOn: row["dependent on"] || null,
        startTimeSetting: row["start time setting"] || null,
        decisionStep: row["decision step?"] === "Yes",
        ifTrueStep: row["if true -> step"],
        elseStep: row["else -> step"],
        taskEndDays: parseFloat(row.taskEndDays || 0),
        assignedBy: req.cookies.userId,
        createdBy: req.cookies.userId,
        isRecurringTask: isRecurrent,
      };

      // Validate references
      const dept = await Department.findById(taskData.departmentOfAssignToUser);
      if (!dept) throw new Error("Invalid department");

      const doer = await User.findById(taskData.assignedTo).populate(
        "role assignShift",
      );
      if (!doer || doer.role.name !== "Member" || !doer.assignShift) {
        throw new Error("Doer must be Member with shift");
      }

      // Template tasks: NO dates (null) - set at launch
      const task = new FmsTask(taskData);
      await task.save();
      // NEW: Track successful task ID
      createdTasksIds.push(task._id);
      await task.populate([
        "fmsTemplateId",
        "departmentOfAssignToUser",
        "assignedTo",
        "assignedBy",
      ]);

      created.push(task);
      console.log(`📋 Planning task ${task.taskId}: ${task.frequency}`);
    } catch (err) {
      errors.push({ row: i + 1, error: err.message });
    }
  }
  if (createdTasksIds.length > 0) {
    await FmsTemplate.findByIdAndUpdate(templateId, {
      $push: {
        tasks: { $each: createdTasksIds },
      },
    });
    console.log(
      `🔗 Linked ${createdTasksIds.length} tasks to template ${templateId}`,
    );
  }
  res.json({
    success: true,
    message: `${created.length}/${rows.length} template tasks planned (dates set at launch)`,
    created,
    errors,
  });
});

export const getFmsTasksByTemplate = handleAsync(async (req, res) => {
  const { page = 1, limit = 20, status, assignedTo } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = { fmsTemplateId: req.params.id };
  const [tasks, total] = await Promise.all([
    FmsTask.find(filter)
      .populate(
        "fmsTemplateId assignedTo departmentOfAssignToUser assignedBy createdBy",
      )
      .sort("taskId")
      .skip(skip)
      .limit(parseInt(limit)),
    FmsTask.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: tasks,
    pagination: { total, page: parseInt(page), limit: parseInt(limit) },
  });
});
