import cron from "node-cron";
import { isBefore, isAfter, differenceInCalendarDays, addDays } from "date-fns";
import Task from "../models/Task.js";
// Runs every 5 minutes — adjust the schedule if you want hourly/daily runs
// const SCHEDULE = '*/5 * * * * *';
const SCHEDULE = "*/5 * * * *";

function resolveDueDate(task) {
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
  return task.checklist.every((c) => c.isCompleted === true);
}

async function updateTaskStatuses() {
  try {
    const now = new Date();

    // Fetch tasks that potentially need status updates. We include all tasks
    // since the dataset may be small; adjust the filter for large collections.
    const tasks = await Task.find({}).lean();

    const updates = [];
    for (const t of tasks) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const start = t.startDate ? new Date(t.startDate) : null;
      const due = resolveDueDate(t);

      if (start) start.setHours(0, 0, 0, 0);
      if (due) due.setHours(0, 0, 0, 0);

      const completed =
        t.completeStatus === true ||
        t.status === "Completed" ||
        isChecklistComplete(t);

      let newStatus;

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
        updates.push({ id: t._id, status: newStatus });
      }
    }
    // for (const t of tasks) {
    //     const due = resolveDueDate(t);

    //     const completed = t.completeStatus === true || t.status === 'Completed' || isChecklistComplete(t);

    //     let newStatus = t.status || 'Pending';

    //     if (completed) {
    //         if (due && t.updatedAt && isAfter(new Date(t.updatedAt), new Date(due))) {
    //             newStatus = 'Delayed';
    //         } else {
    //             newStatus = 'Completed';
    //         }
    //     } else {
    //         if (due && isBefore(new Date(due), now)) {
    //             newStatus = 'Overdue';
    //         } else if (due) {
    //             const daysDiff = differenceInCalendarDays(new Date(due), now);
    //             if (daysDiff >= 0 && daysDiff <= 2) {
    //                 newStatus = 'Upcoming';
    //             } else {
    //                 newStatus = 'Pending';
    //             }
    //         } else {
    //             newStatus = 'Pending';
    //         }
    //     }

    //     if (t.status !== newStatus) {
    //         updates.push({ id: t._id, status: newStatus });
    //     }
    // }

    // Log updated task IDs and new statuses
    if (updates.length > 0) {
      console.log(
        "[taskStatusUpdate] Updating tasks with IDs and new statuses:",
      );
      updates.forEach((u) =>
        console.log(`  - ID: ${u.id}, New Status: ${u.status}`),
      );
    }

    // Apply updates in bulk
    const bulkOps = updates.map((u) => ({
      updateOne: {
        filter: { _id: u.id },
        update: { $set: { status: u.status } },
      },
    }));
    if (bulkOps.length) {
      await Task.bulkWrite(bulkOps);
    }

    console.log(
      `[taskStatusUpdate] checked ${tasks.length} tasks, updated ${bulkOps.length} statuses`,
    );
  } catch (err) {
    console.error("[taskStatusUpdate] error updating task statuses", err);
  }
}

let started = false;

export default function startTaskStatusCron() {
  if (started) return;
  started = true;
  // Do an immediate run, then schedule
  updateTaskStatuses();
  cron.schedule(SCHEDULE, () => {
    updateTaskStatuses();
  });
}

export { updateTaskStatuses };
