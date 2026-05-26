import TaskAudienceMaster from "../models/TaskAudienceMaster.js";

// ======================================================
// CREATE MASTER
// ======================================================

export const createTaskAudienceMaster = async (req, res) => {
  try {
    const { name, assignmentMode, targetRole, targetUsers, memberRole } =
      req.body;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Name required",
      });
    }

    if (!assignmentMode) {
      return res.status(400).json({
        success: false,
        message: "Assignment mode required",
      });
    }

    // ROLE MODE
    if (assignmentMode === "Role" && !targetRole) {
      return res.status(400).json({
        success: false,
        message: "Target role required",
      });
    }

    // USER MODE
    if (assignmentMode === "Users") {
      if (!memberRole) {
        return res.status(400).json({
          success: false,
          message: "Member role required",
        });
      }

      if (!Array.isArray(targetUsers) || targetUsers.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Target users required",
        });
      }
    }

    // ==================================================
    // CHECK EXISTING
    // ==================================================

    const existing = await TaskAudienceMaster.findOne({
      name: name.trim(),
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "Audience already exists",
      });
    }

    // ==================================================
    // CREATE
    // ==================================================

    const master = await TaskAudienceMaster.create({
      name: name.trim(),

      assignmentMode,

      // role mode
      targetRole: assignmentMode === "Role" ? targetRole : null,

      // user mode
      memberRole: assignmentMode === "Users" ? memberRole : null,

      targetUsers: assignmentMode === "Users" ? targetUsers : [],

      createdBy: req.user._id,
    });

    return res.status(201).json({
      success: true,
      data: master,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: "Failed to create audience master",
    });
  }
};

// ======================================================
// UPDATE MASTER
// ======================================================

export const updateTaskAudienceMaster = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      assignmentMode,
      targetRole,
      targetUsers,
      memberRole,
      isActive,
    } = req.body;

    const master = await TaskAudienceMaster.findById(id);

    if (!master) {
      return res.status(404).json({
        success: false,
        message: "Audience master not found",
      });
    }

    // ==================================================
    // UPDATE
    // ==================================================

    master.name = name || master.name;

    master.assignmentMode = assignmentMode || master.assignmentMode;

    // ROLE MODE
    if (master.assignmentMode === "Role") {
      master.targetRole = targetRole;

      master.memberRole = null;

      master.targetUsers = [];
    }

    // USER MODE
    if (master.assignmentMode === "Users") {
      master.targetRole = null;

      master.memberRole = memberRole || null;

      master.targetUsers = targetUsers || [];
    }

    if (typeof isActive === "boolean") {
      master.isActive = isActive;
    }

    master.updatedBy = req.user._id;

    await master.save();

    return res.status(200).json({
      success: true,
      data: master,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: "Failed to update audience master",
    });
  }
};

// ======================================================
// GET ALL
// ======================================================

export const getTaskAudienceMasters = async (req, res) => {
  try {
    // ==================================================
    // GET SINGLE ACTIVE MASTER
    // ==================================================

    const master = await TaskAudienceMaster.findOne({
      isActive: true,
    })
      .populate("targetRole", "name")
      .populate("memberRole", "name")
      .populate("targetUsers", "name email role")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: master || null,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch audience master",
    });
  }
};
