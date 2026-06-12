import cron from "node-cron";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";

// Run every 5min
import { isFmsTaskFullyComplete } from "../utils/fmsTaskValidator.js";

export const updateInstanceProgress = async () => {
  console.log(
    "🔄 FMS Instance Progress Cron - Processing ALL active instances (every 5 min)",
  );

  // Broaden query to catch ALL potentially active instances
  // const instances = await FmsInstance.find({
  //   status: { $nin: ["Completed", "Cancelled", "Stopped"] },
  // });
  const instances = await FmsInstance.find({
    status: { $in: ["Upcoming", "Ongoing", "InProcess"] },
    isStopped: false, // extra safety
  });
  console.log(`📊 Found ${instances.length} FMS instances to process`);

  // SINGLE LOOP: Process each instance completely
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];
    if (instance.status === "Onhold" || instance.status === "Stopped") {
      console.log(`⏸️ Skipping ${instance.instanceId} (${instance.status})`);
      continue;
    }
    console.log(
      `🔄 Processing instance ${i + 1}/${instances.length}: ${instance.instanceId}`,
    );

    // Fetch ALL tasks for this instance ONCE
    const allTasks = await FmsInstanceTask.find({
      fmsInstanceId: instance._id,
    });
    console.log(
      `📝 Instance ${instance.instanceId}: ${allTasks.length} total tasks`,
    );

    if (allTasks.length === 0) {
      console.log(`⏭️ Skipping ${instance.instanceId} - no tasks`);
      continue;
    }

    // 1. Auto-complete ready tasks
    // let autoCompletedCount = 0;
    // for (const task of allTasks) {
    //   if (instance.status === "Onhold" || instance.status === "Stopped") {
    //     continue; // ❌ DO NOTHING
    //   }
    //   if (
    //     task.status !== "Completed" &&
    //     task.status !== "Cancelled" &&
    //     isFmsTaskFullyComplete(task)
    //   ) {
    //     task.status = "Completed";
    //     task.actualCompleteDate = new Date();
    //     await task.save();
    //     console.log(`✅ Auto-completed ${instance.instanceId}/${task.taskId}`);
    //     autoCompletedCount++;
    //   }
    // }
    // if (autoCompletedCount > 0) {
    //   console.log(
    //     `🎉 ${instance.instanceId}: Auto-completed ${autoCompletedCount} tasks`,
    //   );
    // }

    // 2. CORRECT progress calculation (after auto-complete)
    const completedTasks = allTasks.filter(
      (task) => task.status === "Completed",
    ).length;
    const totalTasks = allTasks.length;
    const rate = totalTasks
      ? Math.round((completedTasks / totalTasks) * 100)
      : 0;

    console.log(
      `📊 ${instance.instanceId}: ${completedTasks}/${totalTasks} completed (${rate}%)`,
    );

    // 3. Auto-complete instance if 100%
    const isFinalState =
      instance.status === "Completed" || instance.status === "InProcess";
    const timelessInstance = instance.fmsDuration === "Timeless";
    if (rate === 100 && !isFinalState) {
      instance.status = timelessInstance ? "InProcess" : "Completed";
      console.log(`🏆 Instance ${instance.instanceId} AUTO-COMPLETED! 🎉`);
    }

    // 4. Update progress
    instance.progress = {
      totalTasks,
      completedTasks,
      rate,
      lastUpdated: new Date(),
    };
    await instance.save();

    console.log(`✅ ${instance.instanceId} updated: ${rate}%`);
  }
};

// Schedule: every 5 minutes
const startFMSProgressCronJobs = () => {
  cron.schedule("*/5 * * * * *", updateInstanceProgress, {
    timezone: "Asia/Kolkata",
  });
  console.log(
    "🔄 FMS Instance Progress Cron scheduled: Every 5 minutes (*/5 * * * *)",
  );
};

export default startFMSProgressCronJobs;
