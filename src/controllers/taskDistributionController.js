import Task from "../models/Task.js";
import TaskDelegationFlow from "../models/TaskDelegationFlow.js";

export const getDistributionInbox = async (req, res) => {
  try {
    const currentUser = req.cookies.userId || req.user._id;

    const tasks = await Task.find({
      delegationFlowEnabled: true,
      currentHolder: currentUser,
      distributionStatus: "Awaiting Distribution",
    })
      .populate("assignedBy", "name")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const forwardTask = async (req, res) => {
  try {
    const { id } = req.params;

    const { toUser, remarks, assignedDepartment } = req.body;

    const currentUser = req.cookies.userId || req.user._id;

    const task = await Task.findById(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    if (String(task.currentHolder) !== String(currentUser)) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized",
      });
    }

    task.currentHolder = toUser;

    task.delegationLevel += 1;

    task.distributionStatus = "Awaiting Distribution";

    await task.save();

    await TaskDelegationFlow.create({
      taskId: task._id,

      level: task.delegationLevel,

      fromUser: currentUser,

      toUser,

      assignedDepartment,

      remarks,

      actionType: "Forwarded",
    });

    res.json({
      success: true,
      message: "Task forwarded successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const assignFinalWorker = async (req, res) => {
  try {
    const { id } = req.params;

    const { employeeId, remarks } = req.body;

    const currentUser = req.cookies.userId || req.user._id;

    const task = await Task.findById(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    task.assignedTo = employeeId;

    task.finalAssignedTo = employeeId;

    task.currentHolder = employeeId;

    task.distributionStatus = "Assigned";

    // task.status = "Pending";

    await task.save();

    await TaskDelegationFlow.create({
      taskId: task._id,

      level: task.delegationLevel + 1,

      fromUser: currentUser,

      toUser: employeeId,

      remarks,

      actionType: "Assigned",
    });

    res.json({
      success: true,
      message: "Worker assigned successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getTaskFlowHistory = async (req, res) => {
  try {
    const { id } = req.params;

    const flows = await TaskDelegationFlow.find({
      taskId: id,
    })
      .populate("fromUser", "name")
      .populate("toUser", "name")
      .sort({ level: 1 });

    res.json({
      success: true,
      data: flows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
