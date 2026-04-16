import cron from "node-cron";
import { isBefore, isAfter, differenceInCalendarDays, addDays } from "date-fns";
import Task from "../models/Task.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js"; // 👈 ADDED
import FmsInstance from "../models/FmsInstance.js";

const SCHEDULE = "*/5 * * * *";

function resolveDueDate(task) {
  if (task.plannedDueDate) return task.plannedDueDate; // FMS Priority
  if (task.dueDate) return task.dueDate;
  if (task.endDate) return task.endDate;
  if (task.startDate && typeof task.taskEndDays === "number") {
    return addDays(task.startDate, task.taskEndDays || 0);
  }
  return null;
}

function isChecklistComplete(task) {
  if (!Array.isArray(task.checklist) || task.checklist.length === 0)
    return false;
  return task.checklist.every(
    (c) => c.completed === true || c.isCompleted === true,
  );
}

async function updateTaskStatuses() {
  try {
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 1️⃣ REGULAR TASKS
    const regularTasks = await Task.find({}).lean();
    const regularUpdates = [];

    for (const t of regularTasks) {
      const start = t.startDate ? new Date(t.startDate) : null;
      const due = resolveDueDate(t);

      if (start) start.setHours(0, 0, 0, 0);
      if (due) due.setHours(0, 0, 0, 0);

      const completed = t.status === "Completed" || isChecklistComplete(t);
      let newStatus = t.status || "Pending";

      if (completed) {
        newStatus = "Completed";
      } else if (start && start > today) {
        newStatus = "Upcoming";
      } else if (due && due.getTime() === today.getTime()) {
        newStatus = "Delayed";
      } else if (due && due < today) {
        newStatus = "Overdue";
      } else {
        newStatus = "Pending";
      }

      if (t.status !== newStatus) {
        regularUpdates.push({ id: t._id, status: newStatus });
      }
    }
    const blockedInstances = await FmsInstance.find({
      status: { $in: ["Onhold", "Stopped"] },
    });

    const blockedInstanceIds = new Set(
      blockedInstances.map((i) => i._id.toString()),
    );
    // 2️⃣ FMS INSTANCE TASKS (NEW!)
    const fmsTasks = await FmsInstanceTask.find({}).lean();
    const fmsUpdates = [];

    for (const t of fmsTasks) {
      const instanceIdStr = t.fmsInstanceId.toString();

      if (blockedInstanceIds.has(instanceIdStr)) {
        const parentInstance = blockedInstances.find(
          (i) => i._id.toString() === instanceIdStr,
        );

        const newStatus =
          parentInstance.status === "Stopped" ? "Stopped" : "Onhold";
        if (t.status !== newStatus) {
          fmsUpdates.push({ id: t._id, status: newStatus });
        }

        continue; // ⛔ skip normal logic
      }
      // Skip already completed/cancelled
      if (t.status === "Completed" || t.status === "Cancelled") continue;

      const start = t.plannedStartDate ? new Date(t.plannedStartDate) : null;
      const due = t.plannedDueDate ? new Date(t.plannedDueDate) : null;

      if (start) start.setHours(0, 0, 0, 0);
      if (due) due.setHours(0, 0, 0, 0);

      let newStatus = t.status || "Upcoming";

      if (start && start > today) {
        newStatus = "Upcoming";
      } else if (due && due.getTime() === today.getTime()) {
        newStatus = "Delayed";
      } else if (due && due < today) {
        newStatus = "Overdue";
      } else {
        newStatus = "Pending";
      }

      if (t.status !== newStatus) {
        fmsUpdates.push({ id: t._id, status: newStatus });
      }
    }

    // 3️⃣ BULK UPDATES
    const allBulkOps = [];

    if (regularUpdates.length > 0) {
      console.log(`[REGULAR] ${regularUpdates.length} task updates`);
      allBulkOps.push(
        ...regularUpdates.map((u) => ({
          updateOne: {
            filter: { _id: u.id },
            update: { $set: { status: u.status } },
          },
        })),
      );
      await Task.bulkWrite(
        regularUpdates.map((u) => ({
          updateOne: {
            filter: { _id: u.id },
            update: { $set: { status: u.status } },
          },
        })),
      );
    }

    if (fmsUpdates.length > 0) {
      console.log(`[FMS] ${fmsUpdates.length} instance task updates`);
      await FmsInstanceTask.bulkWrite(
        fmsUpdates.map((u) => ({
          updateOne: {
            filter: { _id: u.id },
            update: { $set: { status: u.status } },
          },
        })),
      );
    }

    console.log(
      `✅ Cron: Checked ${regularTasks.length} tasks + ${fmsTasks.length} FMS tasks | Updated ${regularUpdates.length} + ${fmsUpdates.length}`,
    );
  } catch (err) {
    console.error("[taskStatusUpdate] Error:", err);
  }
}

let started = false;
export default function startTaskStatusCron() {
  if (started) return;
  started = true;
  updateTaskStatuses(); // Immediate run
  cron.schedule(SCHEDULE, updateTaskStatuses);
}

export { updateTaskStatuses };
