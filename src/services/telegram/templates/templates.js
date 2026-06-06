import { format } from "date-fns";

const formatDate = (date) => {
  if (!date) return "-";

  return format(new Date(date), "dd MMM yyyy hh:mm a");
};

export const TELEGRAM_TEMPLATES = {
  TASK_ASSIGNED: ({ task, actor }) => `
🔔 <b>Task Assignment Notification</b>

A new task has been assigned to you.

<b>Task ID:</b> ${task.TaskId}
<b>Title:</b> ${task.title}

<b>Assigned By:</b> ${actor?.name || "-"}

<b>Start Date:</b> ${formatDate(task.startDate)}
<b>Due Date:</b> ${formatDate(task.dueDate)}

Please review and initiate the task as per schedule.

<i>Dothis2</i>
`,

  TASK_COMPLETED: ({ task, actor, remark }) => `
✅ <b>Task Completion Notification</b>

The following task has been completed.

<b>Task ID:</b> ${task.TaskId}
<b>Title:</b> ${task.title}

<b>Completed By:</b> ${actor?.name || "-"}

${remark ? `<b>Remarks:</b> ${remark}` : ""}

<i>Dothis2</i>
`,

  TASK_REOPENED: ({ task, actor, remark }) => `
⚠️ <b>Task Reopened</b>

The task below has been reopened.

<b>Task ID:</b> ${task.TaskId}
<b>Title:</b> ${task.title}

<b>Reopened By:</b> ${actor?.name || "-"}

${remark ? `<b>Reason:</b> ${remark}` : ""}

Please review and take the required action.

<i>Dothis2</i>
`,

  TASK_DELEGATED: ({ task, actor }) => `
📌 <b>Task Delegation Notification</b>

A task has been delegated to you.

<b>Task ID:</b> ${task.TaskId}
<b>Title:</b> ${task.title}

<b>Delegated By:</b> ${actor?.name || "-"}

You are now responsible for this task.

<i>Dothis2</i>
`,

  TASK_DUE_TODAY: ({ task }) => `
⏰ <b>Task Due Reminder</b>

This task is due today.

<b>Task ID:</b> ${task.TaskId}
<b>Title:</b> ${task.title}

<b>Due Date:</b> ${formatDate(task.dueDate)}

Please ensure timely completion.

<i>Dothis2</i>
`,

  TASK_OVERDUE: ({ task }) => `
🚨 <b>Overdue Task Alert</b>

The following task is overdue.

<b>Task ID:</b> ${task.TaskId}
<b>Title:</b> ${task.title}

<b>Due Date:</b> ${formatDate(task.dueDate)}

Immediate attention is required.

<i>Dothis2</i>
`,
  TASK_BUCKET_ASSIGNED: ({ task, actor, frontendUrl }) => `
📦 <b>New Task Bucket Assigned</b>

You have received a new task bucket assignment.

<b>Bucket ID:</b> ${task.bucketId}
<b>Title:</b> ${task.title}

<b>Description:</b>
${task.description || "-"}

<b>Created At:</b> ${formatDate(task.createdAt)}
<b>Assigned By:</b> ${actor?.name || "Manager"}

<i>Dothis2</i>
`,
  BUCKET_COMPLETED: ({ task, actor }) => `
🎉 <b>Bucket Completed Successfully</b>

A task bucket has been marked as completed.

<b>Bucket ID:</b> ${task.bucketId}
<b>Title:</b> ${task.title}

<b>Completed By:</b> ${actor.name || "-"}

<b>Completed At:</b> ${task.completedAt || "-"}

${task.remark ? `<b>Remark:</b> ${task.remark}` : ""}

<i>Dothis2</i>

`,
};
