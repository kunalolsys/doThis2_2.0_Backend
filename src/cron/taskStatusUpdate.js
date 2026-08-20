import cron from "node-cron";
import { isBefore, isAfter, differenceInCalendarDays, addDays } from "date-fns";
import Task from "../models/Task.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js"; // 👈 ADDED
import FmsInstance from "../models/FmsInstance.js";

// const SCHEDULE = "*/5 * * * *";
const SCHEDULE = "*/10 * * * * *";
function resolveDueDate(task) {
  if (task.plannedDueDate) return new Date(task.plannedDueDate); // FMS Priority
  if (task.dueDate) return new Date(task.dueDate);
  if (task.endDate) return new Date(task.endDate);
  if (task.startDate && typeof task.taskEndDays === "number") {
    return addDays(new Date(task.startDate), task.taskEndDays || 0);
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
    const now = new Date(); // 🟢 Exact current date & time

    // 1️⃣ REGULAR TASKS
    const regularTasks = await Task.find({}).lean();
    const regularUpdates = [];

    for (const t of regularTasks) {
      const start = t.startDate ? new Date(t.startDate) : null;
      const due = resolveDueDate(t);

      const completed = t.status === "Completed";
      // || isChecklistComplete(t);
      let newStatus = t.status || "Pending";

      if (completed) {
        newStatus = "Completed";
      } else if (start && start > now) {
        newStatus = "Upcoming";
      } else if (due && due < now) {
        newStatus = "Overdue"; // 🟢 Correctly triggers when time surpasses due time (e.g. 11:37 AM > 11:00 AM)
      } else if (start && due && now >= start && now <= due) {
        newStatus = "Pending";
      } else {
        newStatus = "Pending";
      }

      if (t.status !== newStatus) {
        regularUpdates.push({ id: t._id, status: newStatus });
      }
    }

    const blockedInstances = await FmsInstance.find({
      $or: [
        { status: { $in: ["Onhold", "Stopped"] } },
        { isStopped: true },
        { isTerminated: true },
      ],
    }).lean();

    const blockedInstanceIds = new Set(
      blockedInstances.map((i) => i._id.toString()),
    );

    // 2️⃣ FMS INSTANCE TASKS (NEW!)
    const fmsTasks = await FmsInstanceTask.find({}).lean();
    const fmsUpdates = [];

    for (const t of fmsTasks) {
      const instanceIdStr = t.fmsInstanceId ? t.fmsInstanceId.toString() : null;

      if (instanceIdStr && blockedInstanceIds.has(instanceIdStr)) {
        const parentInstance = blockedInstances.find(
          (i) => i._id.toString() === instanceIdStr,
        );

        let newStatus = "Stopped";
        if (
          parentInstance.isTerminated ||
          parentInstance.isStopped ||
          parentInstance.status === "Stopped"
        ) {
          newStatus = "Terminated"; // 👈 Updated status to Terminated
        } else if (parentInstance.status === "Onhold") {
          newStatus = "Onhold";
        }

        if (t.status !== newStatus) {
          fmsUpdates.push({ id: t._id, status: newStatus });
        }

        continue; // ⛔ skip normal logic
      }

      // Skip already completed/cancelled/notdone
      if (
        t.status === "Completed" ||
        t.status === "Cancelled" ||
        t.status == "Not Done"
      )
        continue;

      const start = t.plannedStartDate ? new Date(t.plannedStartDate) : null;
      const due = t.plannedDueDate ? new Date(t.plannedDueDate) : null;

      let newStatus = t.status || "Upcoming";

      if (start && start > now) {
        newStatus = "Upcoming";
      } else if (due && due < now) {
        newStatus = "Overdue"; // 🟢 Correct exact time comparison for FMS
      } else if (start && due && now >= start && now <= due) {
        newStatus = "Pending";
      } else {
        newStatus = "Pending";
      }

      if (t.status !== newStatus) {
        fmsUpdates.push({ id: t._id, status: newStatus });
      }
    }

    // 3️⃣ BULK UPDATES
    if (regularUpdates.length > 0) {
      console.log(`[REGULAR] ${regularUpdates.length} task updates`);
      await Task.bulkWrite(
        regularUpdates.map((u) => ({
          updateOne: {
            filter: { _id: u.id },
            update: {
              $set: {
                status: u.status,
                ...(u.status == "Completed" && {
                  isReopen: false,
                  reopenedBy: null,
                  reopenedAt: null,
                  reopenedReason: null,
                }),
              },
            },
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
