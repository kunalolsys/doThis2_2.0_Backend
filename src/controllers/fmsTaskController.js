import FmsTask from "../models/FmsTask.js";
import FmsTemplate from "../models/FmsTemplate.js";
import User from "../models/User.js";
import Department from "../models/Department.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import { createLog } from "./logController.js";

//**CREATE FMS TASK */
export const createFmsTasks = handleAsync(async (req, res, next) => {
  const { id: templateId } = req.params;
  let rows = Array.isArray(req.body) ? req.body : [req.body];
  const template = await FmsTemplate.findById(templateId).populate("manager");
  if (!template) return next(new AppError("Template not found", 404));

  const created = [];
  const errors = [];
  const createdTasksIds = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isRecurrent = ["Daily", "Weekly", "Monthly", "Anytime"].includes(
      row.frequency,
    );
    try {
      const description = row.description?.trim();
      if (!description) throw new Error("taskDescription required");

      const isDecisionStep =
        row.decisionStep === true ||
        row.decisionStep === "yes" ||
        row.decisionStep === "true";

      // 🟢 Normalization for Linked With Form Boolean
      const linkedWithForm =
        row.linkedWithForm === true ||
        row.linkedWithForm === "yes" ||
        row.linkedWithForm === "true";

      const taskData = {
        fmsTemplateId: row.fmsTemplateId,
        description,
        taskId: row.taskId,
        departmentOfAssignToUser: row.departmentOfAssignToUser,
        assignedTo: row.assignedTo,
        frequency:
          !row.frequency || row.frequency.toLowerCase() === "none"
            ? "None"
            : row.frequency,
        linkedWithForm, // 🟢 LINKED WITH FORM HANDLED
        xValue: parseFloat(row.xValue || 0),
        isDependent: row.isDependent || false,
        dependentOn: row.dependentOn || null,
        startTimeSetting: row.startTimeSetting || null,

        decisionStep: isDecisionStep,
        decisionYesAction: isDecisionStep
          ? row.decisionYesAction || null
          : null,
        triggerFmsTemplate:
          isDecisionStep && row.decisionYesAction === "trigger_fms"
            ? row.triggerFmsTemplate || null
            : null,

        taskEndDays: parseFloat(row.taskEndDays || 0),
        assignedBy: req.cookies?.userId || req.user?._id || null,
        createdBy: req.cookies?.userId || req.user?._id || null,
        isRecurringTask: isRecurrent,
        checklist: row.checklist || [],
        createdForm: row.createdForm || [],
      };

      const dept = await Department.findById(taskData.departmentOfAssignToUser);
      if (!dept) throw new Error("Invalid department");

      const doer = await User.findById(taskData.assignedTo).populate(
        "role assignShift",
      );
      if (!doer || !doer.assignShift) {
        throw new Error("Doer must be Member with shift");
      }

      const task = new FmsTask(taskData);
      await task.save();

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

//**GET TASK BY TEMPLATES */
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

//**UPDATE FMS TASK */
export const updateFmsTask = handleAsync(async (req, res, next) => {
  const updateData = { ...req.body };

  if (updateData.linkedWithForm !== undefined) {
    updateData.linkedWithForm =
      updateData.linkedWithForm === true ||
      updateData.linkedWithForm === "yes" ||
      updateData.linkedWithForm === "true";
  }

  const task = await FmsTask.findOneAndUpdate(
    { fmsTemplateId: req.params.id, taskId: req.params.taskId },
    updateData,
    { new: true },
  ).populate("fmsTemplateId");

  res.json({ success: true, data: task });
});

export const deleteFmsTask = handleAsync(async (req, res, next) => {
  const { id: templateId, taskId } = req.params;

  const task = await FmsTask.findOne({
    fmsTemplateId: templateId,
    taskId,
  }).populate([
    "fmsTemplateId",
    "assignedTo",
    "departmentOfAssignToUser",
    "assignedBy",
  ]);

  if (!task) {
    return next(new AppError(`FMS Task ${taskId} not found in template`, 404));
  }
  const childTask = await FmsTask.findOne({
    fmsTemplateId: templateId,
    dependentOn: task.taskId,
  });

  if (childTask) {
    return next(
      new AppError(
        `Cannot delete task "${task.taskId}". Dependent task "${childTask.taskId}" exists.`,
        400,
      ),
    );
  }

  await FmsTemplate.findByIdAndUpdate(templateId, {
    $pull: { tasks: task._id },
  });

  await task.deleteOne();

  await createLog({
    action: "DELETE_FMS_TASK",
    performedBy: req.cookies.userId || req.user._id || null,
    targetId: task._id,
    targetType: "FmsTask",
    details: `Template task ${task.taskId} deleted from template ${templateId}`,
    metadata: {
      templateId,
      taskId: task.taskId,
      description: task.description.substring(0, 100),
    },
  });

  res.json({
    success: true,
    message: `Template task "${task.taskId}" deleted successfully`,
    deletedTaskId: task.taskId,
  });
});

//**IMPORT FMS TASK */
export const importFmsTasksUniversal = handleAsync(async (req, res) => {
  const templateId = req.params.id;
  const file = req.files?.[0];

  if (!file) {
    return res.status(400).json({ error: "File is required" });
  }

  const format = file.originalname.split(".").pop().toLowerCase();
  let rows = [];

  try {
    if (format === "csv") {
      const csv = file.buffer.toString();
      rows = parse(csv, { header: true, skipEmptyLines: true });
    } else if (format === "json") {
      rows = JSON.parse(file.buffer.toString());
    } else if (["xlsx", "xls"].includes(format)) {
      const workbook = XLSX.read(file.buffer);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet);
    } else {
      return res.status(400).json({ error: "Supported: CSV, JSON, XLSX" });
    }
  } catch (err) {
    return res.status(400).json({ error: "Invalid file format" });
  }

  const created = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    try {
      if (!row.description) throw new Error("Missing taskDescription");
      if (!row.doer) throw new Error("Missing assignedTo (doer)");
      if (!row.department) throw new Error("Missing department");

      const allowedFrequencies = [
        "None",
        "Anytime",
        "Daily",
        "Weekly",
        "Monthly",
        "Start+X in days",
        "Start+X in hours",
        "Form Event+X in days",
        "Form Event+X in hours",
        "Task+X in days",
        "Task+X in hours",
        "Task-X in days",
        "Task-X in hours",
        "Event+X in days",
        "Event+X in hours",
        "Event-X in days",
        "Event-X in hours",
      ];

      const freq = row.frequency || "None";
      if (!allowedFrequencies.includes(freq)) {
        throw new Error(`Invalid frequency: ${freq}`);
      }

      let checklist = [];
      if (row.checkList) {
        try {
          const parsed = JSON.parse(row.checkList);
          checklist = Array.isArray(parsed)
            ? parsed.map((item) => ({
                text: item.text || item,
                completed: false,
              }))
            : [];
        } catch {
          throw new Error("Invalid checklist JSON");
        }
      }

      let createdForm = [];
      if (row.createdForm) {
        try {
          const parsed = JSON.parse(row.createdForm);
          createdForm = Array.isArray(parsed)
            ? parsed.map((f) => ({
                fieldName: f.fieldName,
                fieldType: f.fieldType || "text",
                isMandatory: !!f.isMandatory,
              }))
            : [];
        } catch {
          throw new Error("Invalid createdForm JSON");
        }
      }

      const user = await User.findOne({ email: row.doer });
      if (!user) throw new Error(`User not found: ${row.doer}`);

      const dept = await Department.findOne({ name: row.department });
      if (!dept) throw new Error(`Department not found: ${row.department}`);

      const taskData = {
        fmsTemplateId: templateId,
        description: row.description,
        assignedTo: user._id,
        departmentOfAssignToUser: dept._id,
        frequency: freq,
        linkedWithForm:
          row.linkedWithForm === "true" || row.linkedWithForm === true,
        xValue: Number(row.value) || 0,
        checklist,
        createdForm,
        isDependent: row.isDependent === "true" || row.isDependent === true,
        dependentOn: row.dependentOn || null,
        startTimeSetting: row.startTimeSetting || undefined,
        isRecurringTask: row.isRecurringTask === "true",
        taskEndDays: Number(row.taskEndDays) || 0,
        createdBy: req.cookies.userId || req.user._id || null,
      };

      const task = await FmsTask.create(taskData);
      created.push(task.taskId);
    } catch (err) {
      errors.push({
        row: i + 1,
        message: err.message,
      });
    }
  }

  res.json({
    success: true,
    format,
    total: rows.length,
    imported: created.length,
    failed: errors.length,
    createdTaskIds: created,
    errors,
  });
});
