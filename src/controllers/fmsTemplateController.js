import FmsTemplate from "../models/FmsTemplate.js";
import FmsTask from "../models/FmsTask.js";
import User from "../models/User.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import { createLog } from "./logController.js";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";

export const createTemplate = handleAsync(async (req, res, next) => {
  const {
    templateName,
    description,
    fmsDuration,
    endDate,
    manager,
    srManager,
  } = req.body;
  const userId = req.cookies.userId || req.user._id || null;

  // Check duplicate templateName (Mongo unique will catch but custom msg better)
  const existing = await FmsTemplate.findOne({ templateName });
  if (existing) {
    return next(new AppError(`Template "${templateName}" already exists`, 400));
  }

  // Role validation (BRD)
  const managerUser = await User.findById(manager).populate("role");
  if (!managerUser || managerUser.role.name !== "Manager") {
    return next(new AppError("Manager must have Manager role", 400));
  }
  if (srManager) {
    const srUser = await User.findById(srManager).populate("role");
    if (!srUser || srUser.role.name !== "Sr. Manager") {
      return next(new AppError("Sr Manager must have Sr Manager role", 400));
    }
  }

  const template = await FmsTemplate.create({
    templateName,
    description: description || "",
    fmsDuration,
    endDate: fmsDuration === "Fixed Period" ? endDate : undefined,
    manager: managerUser._id,
    srManager: srManager || undefined,
    user: userId,
  });

  await template.populate([
    "manager",
    "srManager",
    "taskCount",
    "instanceCount",
  ]);

  await createLog({
    action: "CREATE_TEMPLATE",
    module: "FMS_TEMPLATE",
    performedBy: userId,
    documentId: template._id,
    newData: template,
  });

  res.status(201).json({
    success: true,
    data: template,
  });
});
//**Import Templates */
export const importFmsTemplates = handleAsync(async (req, res, next) => {
  const { templates } = req.body; // Expect array: [{templateName, description, fmsDuration, endDate?, manager, srManager?}]
  const userId = req.cookies.userId || req.user._id || null;

  if (!Array.isArray(templates) || templates.length === 0) {
    return next(new AppError("Provide templates array in request body", 400));
  }

  const createdTemplates = [];
  const errors = [];

  for (const data of templates) {
    try {
      const {
        templateName,
        description = "",
        fmsDuration,
        endDate,
        manager: managerName,
        srManager: srManagerName,
      } = data;

      // Validate required
      if (!templateName || !fmsDuration || !managerName) {
        errors.push({ templateName, error: "Missing required fields" });
        continue;
      }

      // Check Manager role
      // 🔥 Find manager by name
      const managerUser = await User.findOne({
        name: managerName,
        isDeleted: false,
      }).populate("role");

      if (!managerUser) {
        errors.push({ templateName, error: "Manager not found" });
        continue;
      }

      // 🔥 Validate role
      if (managerUser.role?.name !== "Manager") {
        errors.push({ templateName, error: "Manager must have Manager role" });
        continue;
      }

      // 🔥 Find srManager if provided
      let srUser = null;

      if (srManagerName) {
        srUser = await User.findOne({
          name: srManagerName,
          isDeleted: false,
        }).populate("role");

        if (!srUser) {
          errors.push({ templateName, error: "Sr Manager not found" });
          continue;
        }

        if (srUser.role?.name !== "Sr. Manager") {
          errors.push({
            templateName,
            error: "Sr Manager must have Sr Manager role",
          });
          continue;
        }
      }

      // Check duplicate
      const existing = await FmsTemplate.findOne({
        templateName,
        isDeleted: false,
      });

      if (existing) {
        errors.push({ templateName, error: "Template already exists" });
        continue;
      }
      // Validate & parse Fixed Period endDate (DD-MM-YYYY -> ISO)
      let parsedEndDate;
      if (fmsDuration === "Fixed Period") {
        if (!endDate) {
          errors.push({
            templateName,
            error: "endDate required for Fixed Period",
          });
          continue;
        }
        // Parse DD-MM-YYYY to Date
        const [day, month, year] = endDate.split("-").map(Number);
        parsedEndDate = new Date(year, month - 1, day); // month 0-indexed
        if (isNaN(parsedEndDate.getTime())) {
          errors.push({
            templateName,
            error: `Invalid endDate format "${endDate}". Use DD-MM-YYYY`,
          });
          continue;
        }
      }

      const template = await FmsTemplate.create({
        templateName,
        description,
        fmsDuration,
        endDate: fmsDuration === "Fixed Period" ? parsedEndDate : undefined,
        manager: managerUser._id,
        srManager: srUser?._id,
        user: userId,
      });

      await template.populate(["manager", "srManager"]);
      createdTemplates.push(template);
    } catch (err) {
      errors.push({ templateName: data.templateName, error: err.message });
    }
  }

  res.status(201).json({
    success: true,
    message: `${createdTemplates.length} templates created, ${errors.length} errors`,
    created: createdTemplates,
    errors,
  });
});

export const getTemplates = handleAsync(async (req, res) => {
  const { page = 1, limit = 10, search, managerId, fmsDuration } = req.body;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = { isDeleted: false };
  if (search) {
    filter.templateName = { $regex: search, $options: "i" };
  }
  if (managerId) {
    filter.manager = managerId;
  }
  if (fmsDuration) {
    filter.fmsDuration = fmsDuration;
  }

  const [templates, total] = await Promise.all([
    FmsTemplate.find(filter)
      .populate("manager srManager", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    FmsTemplate.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: templates,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
    },
  });
});
export const getTemplatesForDropdown = handleAsync(async (req, res) => {
  const templates = await FmsTemplate.find({ isDeleted: false })
    .select("_id templateName fmsId description fmsDuration endDate isLaunched")
    .populate("manager", "name email")
    .populate("srManager", "name email")
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    data: templates,
  });
});
export const getTemplateById = handleAsync(async (req, res, next) => {
  const template = await FmsTemplate.findById(req.params.id)
    .populate("manager", "name email")
    .populate("srManager", "name email")
    .populate({
      path: "tasks",
      populate: [
        { path: "assignedTo", select: "name email" },
        { path: "departmentOfAssignToUser", select: "name" },
        { path: "assignedBy", select: "name email" },
      ],
    });

  if (!template) return next(new AppError("Template not found", 404));

  // Load tasks separately (since one-to-many)
  const tasks = await FmsTask.find({ fmsTemplateId: template._id })
    // .populate('assignedTo departmentOfAssignToUser', 'name email')
    .populate("assignedTo", "name email")
    .populate("departmentOfAssignToUser", "name")
    .populate("assignedBy", "name email")
    .sort("taskId");

  res.json({
    success: true,
    data: {
      ...template.toObject(),
      tasks,
    },
  });
});

export const updateTemplate = handleAsync(async (req, res, next) => {
  const { id } = req.params;
  const updateData = req.body;
  const userId = req.cookies.userId || req.user._id || null;

  const template = await FmsTemplate.findById(id);
  if (!template) return next(new AppError("Template not found", 404));

  const oldData = template.toObject();

  // Duplicate check (exclude self)
  if (
    updateData.templateName &&
    updateData.templateName !== template.templateName
  ) {
    const dupe = await FmsTemplate.findOne({
      templateName: updateData.templateName,
      _id: { $ne: id },
    });
    if (dupe) {
      return next(
        new AppError(
          `Template "${updateData.templateName}" already exists`,
          400,
        ),
      );
    }
  }

  // Role validation if changed
  if (updateData.manager) {
    const managerUser = await User.findById(updateData.manager).populate(
      "role",
    );
    if (!managerUser || managerUser.role.name !== "Manager") {
      return next(new AppError("Manager must have Manager role", 400));
    }
  }
  if (updateData.srManager) {
    const srUser = await User.findById(updateData.srManager).populate("role");
    if (!srUser || srUser.role.name !== "Sr. Manager") {
      return next(new AppError("Sr Manager must have Sr Manager role", 400));
    }
  }

  Object.assign(template, updateData);
  await template.save();

  await template.populate([
    "manager",
    "srManager",
    "taskCount",
    "instanceCount",
  ]);

  await createLog({
    action: "UPDATE_TEMPLATE",
    module: "FMS_TEMPLATE",
    performedBy: userId,
    documentId: template._id,
    oldData,
    newData: template,
  });

  res.json({ success: true, data: template });
});

export const deleteTemplate = handleAsync(async (req, res, next) => {
  const { force } = req.query;
  const { reason } = req.body;

  const template = await FmsTemplate.findById(req.params.id);
  if (!template || template.isDeleted) {
    return next(new AppError("Template not found", 404));
  }
  // 1. Check if template was launched
  if (template.isLaunched && force !== "true") {
    return next(
      new AppError(
        "Template has been launched. Stop all related instances first.",
        400,
      ),
    );
  }

  // 2. Check active instances regardless
  const activeInstances = await FmsInstance.find({
    fmsTemplateId: template._id,
    status: { $nin: ["Cancelled", "Completed", "Stopped", "Onhold"] },
  });

  if (activeInstances.length > 0 && force !== "true") {
    return next(
      new AppError(
        `${activeInstances.length} active instances exist. Stop them first or use ?force=true`,
        400,
      ),
    );
  }

  // 2️⃣ SOFT DELETE TEMPLATE
  template.isDeleted = true;
  template.deletedAt = new Date();
  template.deletedBy = req.cookies.userId || req.user._id || null;
  template.deleteReason = reason || "No reason provided";
  await template.save();

  // 3️⃣ DELETE ALL RELATED DATA (CASCADE)
  const instances = await FmsInstance.find({
    fmsTemplateId: template._id,
  }).select("_id");

  const instanceIds = instances.map((i) => i._id);

  // 🔥 Delete instance tasks
  await FmsInstanceTask.deleteMany({
    fmsInstanceId: { $in: instanceIds },
  });

  // 🔥 Delete instances
  await FmsInstance.deleteMany({
    _id: { $in: instanceIds },
  });

  // 🔥 Delete template tasks
  await FmsTask.deleteMany({
    fmsTemplateId: template._id,
  });
  // Log & delete
  await createLog({
    action: "DELETE_TEMPLATE",
    module: "FMS_TEMPLATE",
    performedBy: req.cookies.userId || req.user._id || null,
    documentId: template._id,
    oldData: template,
    message: `Template deleted. Reason: ${reason || "N/A"}`,
  });

  // await FmsTemplate.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: "Template deleted successfully" });
});

export const getTemplateTasks = handleAsync(async (req, res) => {
  // const skip = (parseInt(page) - 1) * parseInt(limit);

  const { search, departmentId } = req.body;

  const filter = { fmsTemplateId: req.params.id };

  if (search) {
    filter.$or = [
      { taskId: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  if (departmentId) {
    filter.departmentOfAssignToUser = departmentId;
  }

  const [tasks, total] = await Promise.all([
    FmsTask.find(filter)
      .populate("assignedTo", "name email")
      .populate("departmentOfAssignToUser", "name")
      .populate("assignedBy", "name email")
      .sort("taskId"),
    // .skip(skip)
    // .limit(parseInt(limit)),
    FmsTask.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: tasks,
    // pagination: {
    //   total,
    //   page: parseInt(page),
    //   limit: parseInt(limit),
    // },
  });
});
