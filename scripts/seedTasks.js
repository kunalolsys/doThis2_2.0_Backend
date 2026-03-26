import mongoose from "mongoose";
import {DelegationTask, RecurringTask } from "../src/models/Task.js";

const MONGO_URI = "mongodb://localhost:27017/dothis2_2";

// 🔥 Helpers
const today = new Date();
today.setHours(0, 0, 0, 0);

const daysAgo = (d) => {
  const date = new Date(today);
  date.setDate(date.getDate() - d);
  return date;
};

const daysAhead = (d) => {
  const date = new Date(today);
  date.setDate(date.getDate() + d);
  return date;
};

const seed = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Mongo Connected");

    const userIds =["693a4d43477c1d3161d8cb7e","693a4d43477c1d3161d8cb7e","693a4d43477c1d3161d8cb7e"];

    const tasks = [];

    // 🟢 1. PENDING (Today)
    tasks.push({
      type: "delegation",
      data: {
        title: "Check Inventory",
        description: "Verify warehouse stock",
        assignedTo: userIds[0],
        startDate: today,
        dueDate: daysAhead(2),
      }
    });

    // 🔵 2. UPCOMING (Future)
    tasks.push({
      type: "delegation",
      data: {
        title: "Plan Campaign",
        description: "Marketing strategy",
        assignedTo: userIds[1],
        startDate: daysAhead(2),
        dueDate: daysAhead(5),
      }
    });

    // 🔴 3. OVERDUE
    tasks.push({
      type: "delegation",
      data: {
        title: "Fix Critical Bug",
        description: "Payment issue",
        assignedTo: userIds[0],
        startDate: daysAgo(5),
        dueDate: daysAgo(2),
      }
    });

    // ⚠️ 4. DELAYED (today = due date)
    tasks.push({
      type: "delegation",
      data: {
        title: "Submit Report",
        description: "Monthly report",
        assignedTo: userIds[1],
        startDate: daysAgo(2),
        dueDate: today,
      }
    });

    // ✅ 5. COMPLETED
    tasks.push({
      type: "delegation",
      data: {
        title: "Client Call Done",
        description: "Discussion completed",
        assignedTo: userIds[0],
        startDate: daysAgo(3),
        dueDate: daysAgo(1),
        completeStatus: true
      }
    });

    // 📋 6. CHECKLIST TASK
    tasks.push({
      type: "delegation",
      data: {
        title: "Employee Onboarding",
        description: "Setup new employee",
        assignedTo: userIds[2],
        startDate: today,
        checklist: [
          { text: "Create email" },
          { text: "Assign system" },
          { text: "HR briefing" }
        ]
      }
    });

    // 🔁 7. RECURRING DAILY
    tasks.push({
      type: "recurring",
      data: {
        title: "Daily Backup",
        description: "Backup DB",
        assignedTo: userIds[0],
        startDate: today,
        frequency: "Daily"
      }
    });

    // 🔁 8. RECURRING WEEKLY
    tasks.push({
      type: "recurring",
      data: {
        title: "Weekly Meeting",
        description: "Team sync",
        assignedTo: userIds[1],
        startDate: today,
        frequency: "Weekly",
        weekDays: ["monday", "friday"]
      }
    });

    // 🔗 9. PARENT TASK (for dependency)
    const parentTask = await new DelegationTask({
      title: "Complete Backend API",
      description: "Finish API development",
      assignedTo: userIds[0],
      startDate: today,
      dueDate: daysAhead(2)
    }).save();

    console.log("✅ Parent Task Created:", parentTask.TaskId);

    // 🔗 10. DEPENDENT TASK
    tasks.push({
      type: "delegation",
      data: {
        title: "Deploy API",
        description: "Deploy after backend complete",
        assignedTo: userIds[1],
        isDependent: true,
        dependencyConfig: {
          taskDependent: parentTask._id,
          startTimeSetting: "planned-to-planned",
          isDependentFrequency: "T+X in days",
          xValue: 1
        },
        taskEndDays: 2
      }
    });

    // 🚀 BULK RANDOM TASKS
    for (let i = 1; i <= 20; i++) {
      tasks.push({
        type: "delegation",
        data: {
          title: `Auto Task ${i}`,
          description: "Generated task",
          assignedTo: userIds[i % userIds.length],
          startDate: Math.random() > 0.5 ? daysAgo(i % 5) : daysAhead(i % 5),
          taskEndDays: Math.floor(Math.random() * 3) + 1
        }
      });
    }

    // 💾 SAVE ALL
    for (const item of tasks) {
      if (item.type === "recurring") {
        await new RecurringTask(item.data).save();
      } else {
        await new DelegationTask(item.data).save();
      }
    }

    console.log("🎉 All tasks seeded successfully!");
    process.exit();

  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
};

seed();