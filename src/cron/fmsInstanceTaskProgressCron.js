import cron from "node-cron";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";

// Run every 5min
import { isFmsTaskFullyComplete } from "../utils/fmsTaskValidator.js";

const updateInstanceProgress = async () => {
  console.log("🔄 FMS Instance Progress Cron scheduled: At every 5 min");

  const instances = await FmsInstance.find({
    status: { $in: ["Upcoming", "Ongoing"] },
  });

  // Auto-complete ready tasks
  for (const instance of instances) {
    const readyTasks = await FmsInstanceTask.find({
      fmsInstanceId: instance._id,
      status: { $nin: ['Completed', 'Cancelled'] },
    });

    for (const task of readyTasks) {
      if (isFmsTaskFullyComplete(task) && task.status !== 'Completed') {
        task.status = 'Completed';
        task.actualCompleteDate = new Date();
        await task.save();
        console.log(`✅ Auto-completed task ${task.taskId}`);
      }
    }
  }

  // Then calculate progress
  for (const instance of instances) {
    const totalTasks = await FmsInstanceTask.countDocuments({
      fmsInstanceId: instance._id,
    });
    const pendingTasks = await FmsInstanceTask.find({
      fmsInstanceId: instance._id,
      status: { $in: ['Upcoming', 'Pending', 'Delayed', 'Overdue'] }
    });

    const fullyCompleteCount = pendingTasks.filter(isFmsTaskFullyComplete).length;
    const completed = totalTasks - pendingTasks.length + fullyCompleteCount;
    const total = totalTasks;

    const rate = total ? Math.round((completed / total) * 100) : 0;

    // AUTO COMPLETE 100%
    if (rate === 100) {
      instance.status = "Completed";
      instance.history.push({ event: "auto-completed", rate: 100 });
    }

    instance.progress = {
      totalTasks: total,
      completedTasks: completed,
      rate,
      lastUpdated: new Date(),
    };
    await instance.save();

    // Update TEMPLATE progress too
    await updateTemplateFromInstance(instance._id);
  }
};

// Schedule: at every 5 minutes
const startFMSProgressCronJobs = () => {
    cron.schedule("*/5 * * * *", updateInstanceProgress, {
  // cron.schedule("*/3 * * * * *", updateInstanceProgress, {
    timezone: "Asia/Kolkata",
  });
  console.log("🔄 FMS Instance Progress Cron scheduled: At every 5 min");
};

export default startFMSProgressCronJobs;
