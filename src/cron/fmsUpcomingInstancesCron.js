import cron from "node-cron";
import moment from "moment-timezone";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsTask from "../models/FmsTask.js";
import User from "../models/User.js";
import {
  nextWorkingShiftDate,
  snapToShiftTime,
  isWorkingDay as checkIsWorkingDay,
  isHoliday,
} from "../utils/dateCalculator.js";
import { sendNotification } from "../services/telegram/services/taskTelegramService.js";
import sendEmail from "../services/emailService.js";
import { taskAssignedTemplate } from "../services/templates/taskAssignedTemp.js";

// Safe non-blocking notification runner
const safeSendNotifications = async ({ task, actor, recipient }) => {
  try {
    sendNotification({
      type: "TASK_ASSIGNED",
      task,
      actor,
    }).catch((e) =>
      console.error(`[Telegram Error] Task ${task?.taskId}:`, e.message),
    );

    if (recipient?.email) {
      const emailTemplate = taskAssignedTemplate({
        userName: recipient.name,
        taskId: task.taskId,
        title: task.description,
        description: task.description,
        dueDate: task.plannedDueDate
          ? new Date(task.plannedDueDate).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })
          : "N/A",
        assignedBy: actor?.name,
      });

      sendEmail({
        to: recipient.email,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
      }).catch((e) =>
        console.error(`[Email Error] Task ${task?.taskId}:`, e.message),
      );
    }
  } catch (err) {
    console.error(
      `[Notification Handler Warning] Task ${task?.taskId}:`,
      err.message,
    );
  }
};

const isWithinInstanceWindow = (instance, todayMoment) => {
  const start = moment(instance.startDate).tz("Asia/Kolkata").startOf("day");
  if (todayMoment.isBefore(start)) return false;

  if (instance.fmsDuration === "Timeless") return true;

  if (instance.endDate) {
    const end = moment(instance.endDate).tz("Asia/Kolkata").endOf("day");
    return !todayMoment.isAfter(end);
  }

  // Fixed Period but no endDate -> safest: don't generate
  return false;
};

const isTaskDueForTodayByInstanceMode = async (task, instance, todayMoment) => {
  const todayDate = todayMoment.toDate();

  // Evaluate working day status and holidays using department/user-aware dateCalculator
  const [isWorking, holiday] = await Promise.all([
    checkIsWorkingDay(todayDate, null, task.assignedTo),
    isHoliday(todayDate, task.assignedTo),
  ]);

  if (holiday || !isWorking) {
    return false;
  }

  // Timeless instances generate Anytime / Daily tasks every valid working day
  if (instance.fmsDuration === "Timeless") {
    if (task.frequency === "Anytime" || task.frequency === "Daily") return true;
  }

  const todayDayName = todayMoment.format("dddd").toLowerCase();

  switch (task.frequency) {
    case "Daily":
    case "Anytime":
      return true;

    case "Weekly": {
      const start = moment(instance.startDate)
        .tz("Asia/Kolkata")
        .startOf("day");
      const startDay = start.format("dddd").toLowerCase();
      return todayDayName === startDay;
    }

    case "Monthly": {
      const start = moment(instance.startDate)
        .tz("Asia/Kolkata")
        .startOf("day");
      const expected = todayMoment.clone().date(start.date());
      if (!expected.isValid()) expected.date(1);
      return todayMoment.isSame(expected, "day");
    }

    default:
      return false;
  }
};

const generateDependentChildren = async (
  instance,
  parentInstanceTask,
  parentTemplateTask,
) => {
  try {
    const children = await FmsTask.find({
      dependentOn: parentTemplateTask.taskId,
      isDependent: true,
    }).lean();

    for (const childTemplate of children) {
      try {
        const alreadyExists = await FmsInstanceTask.exists({
          fmsInstanceId: instance._id,
          fmsTaskId: childTemplate._id,
          dependentOn: parentInstanceTask.taskId,
          recurrenceKey: parentInstanceTask.recurrenceKey,
        });
        if (alreadyExists) continue;

        const [doer, assignedByUser, assignedToUser] = await Promise.all([
          User.findById(childTemplate.assignedTo)
            .populate("assignShift")
            .lean(),
          User.findById(childTemplate.assignedBy).select("name email").lean(),
          User.findById(childTemplate.assignedTo).select("name email").lean(),
        ]);

        if (!doer?.assignShift) continue;

        const parentDate =
          parentInstanceTask.plannedDueDate ||
          parentInstanceTask.plannedStartDate;
        if (!parentDate) continue;

        const shiftStart = await nextWorkingShiftDate(
          parentDate,
          doer.assignShift._id,
          {},
          doer._id,
        );
        const shiftEnd = snapToShiftTime(shiftStart, doer.assignShift, false);

        const isDecisionStep =
          childTemplate.decisionStep === true ||
          childTemplate.decisionStep === "yes" ||
          childTemplate.decisionStep === "true";

        const childInstanceTask = await FmsInstanceTask.create({
          fmsInstanceId: instance._id,
          fmsTaskId: childTemplate._id,
          formId: instance.formId || parentInstanceTask.formId || null,
          submissionId:
            instance.submissionId || parentInstanceTask.submissionId || null,
          submissionData:
            instance.runtimeContext || parentInstanceTask.submissionData || {},

          taskId: childTemplate.taskId,
          description: childTemplate.description,
          departmentOfAssignToUser: childTemplate.departmentOfAssignToUser,
          assignedTo: childTemplate.assignedTo,
          assignedBy: childTemplate.assignedBy,

          frequency: childTemplate.frequency,
          xValue: childTemplate.xValue,
          isDependent: true,
          dependentOn: parentInstanceTask.taskId,

          startTimeSetting: childTemplate.startTimeSetting,
          plannedStartDate:
            childTemplate.startTimeSetting === "actual-to-planned"
              ? null
              : shiftStart,
          plannedDueDate:
            childTemplate.startTimeSetting === "actual-to-planned"
              ? null
              : shiftEnd,

          status: "Pending",
          isVisible: false,
          checklist: childTemplate.checklist || [],
          createdForm: childTemplate.createdForm || [],

          decisionStep: isDecisionStep,
          decisionYesAction: isDecisionStep
            ? childTemplate.decisionYesAction || null
            : null,
          triggerFmsTemplate:
            isDecisionStep && childTemplate.decisionYesAction === "trigger_fms"
              ? childTemplate.triggerFmsTemplate || null
              : null,

          decisionAnswer: null,
          decisionRemark: null,
          decisionSubmissionId: null,
          triggeredInstanceId: null,

          recurrenceKey: parentInstanceTask.recurrenceKey,
          triggerKey: `RECURRENCE:${instance._id}:${childTemplate._id}:${parentInstanceTask.recurrenceKey}`,
        });

        safeSendNotifications({
          task: childInstanceTask,
          actor: assignedByUser,
          recipient: assignedToUser,
        });

        // Recursive child processing
        await generateDependentChildren(
          instance,
          childInstanceTask,
          childTemplate,
        );
      } catch (childErr) {
        console.error(
          `❌ Error generating dependent child task [${childTemplate?.taskId}]:`,
          childErr,
        );
      }
    }
  } catch (err) {
    console.error("❌ Critical Error in generateDependentChildren:", err);
  }
};

export const generateUpcomingFmsInstanceTasks = async () => {
  console.log(
    "\n🚀 [FMS UPCOMING INSTANCES CRON] -",
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  );

  try {
    const today = moment().tz("Asia/Kolkata").startOf("day");

    const instances = await FmsInstance.find({
      status: { $in: ["Upcoming"] },
      isStopped: false,
    })
      .populate("fmsTemplateId")
      .lean();

    let createdCount = 0;

    for (const instance of instances) {
      try {
        if (
          instance.status === "Onhold" ||
          instance.status === "Stopped" ||
          instance.isStopped ||
          !instance.fmsTemplateId?._id
        ) {
          continue;
        }

        if (!isWithinInstanceWindow(instance, today)) continue;

        const tasks = await FmsTask.find({
          fmsTemplateId: instance.fmsTemplateId._id,
        }).lean();

        for (const task of tasks) {
          try {
            const due = await isTaskDueForTodayByInstanceMode(
              task,
              instance,
              today,
            );
            if (!due) continue;

            const recurrenceKey = today.format("YYYY-MM-DD");

            const already = await FmsInstanceTask.exists({
              fmsInstanceId: instance._id,
              fmsTaskId: task._id,
              recurrenceKey,
            });
            if (already) continue;

            const [user, assignedByUser, assignedToUser] = await Promise.all([
              User.findById(task.assignedTo).populate("assignShift").lean(),
              User.findById(task.assignedBy).select("name email").lean(),
              User.findById(task.assignedTo).select("name email").lean(),
            ]);

            if (!user?.assignShift) continue;

            const shiftStart = await nextWorkingShiftDate(
              new Date(),
              user.assignShift._id,
              {},
              user._id,
            );
            const shiftEnd = snapToShiftTime(
              shiftStart,
              user.assignShift,
              false,
            );

            const count = await FmsInstanceTask.countDocuments({
              fmsInstanceId: instance._id,
              fmsTaskId: task._id,
            });

            const instanceTaskId = `${instance.instanceId}-${task.taskId}-R${count + 1}`;

            const isDecisionStep =
              task.decisionStep === true ||
              task.decisionStep === "yes" ||
              task.decisionStep === "true";

            const parentInstanceTask = await FmsInstanceTask.create({
              fmsInstanceId: instance._id,
              fmsTaskId: task._id,
              formId: instance.formId || null,
              submissionId: instance.submissionId || null,
              submissionData: instance.runtimeContext || {},

              taskId: instanceTaskId,
              description: task.description,
              departmentOfAssignToUser: task.departmentOfAssignToUser,
              assignedTo: task.assignedTo,
              assignedBy: task.assignedBy,

              frequency: task.frequency,
              plannedStartDate: shiftStart,
              plannedDueDate: shiftEnd,

              status: "Upcoming",
              isVisible: false,

              checklist: task.checklist || [],
              createdForm: task.createdForm || [],

              decisionStep: isDecisionStep,
              decisionYesAction: isDecisionStep
                ? task.decisionYesAction || null
                : null,
              triggerFmsTemplate:
                isDecisionStep && task.decisionYesAction === "trigger_fms"
                  ? task.triggerFmsTemplate || null
                  : null,

              decisionAnswer: null,
              decisionRemark: null,
              decisionSubmissionId: null,
              triggeredInstanceId: null,

              recurrenceKey,
              triggerKey: `RECURRENCE:${instance._id}:${task._id}:${recurrenceKey}`,
            });

            createdCount++;

            await generateDependentChildren(instance, parentInstanceTask, task);

            safeSendNotifications({
              task: parentInstanceTask,
              actor: assignedByUser,
              recipient: assignedToUser,
            });
          } catch (taskErr) {
            console.error(
              `❌ Error generating upcoming task [${task?.taskId}]:`,
              taskErr,
            );
          }
        }
      } catch (instanceErr) {
        console.error(
          `❌ Error processing instance [${instance?.instanceId}]:`,
          instanceErr,
        );
      }
    }

    console.log(
      `📊 [FMS UPCOMING INSTANCES CRON] Total created: ${createdCount}`,
    );
  } catch (globalErr) {
    console.error("💥 Fatal Error in Upcoming Instances Cron:", globalErr);
  }
};

const startFmsUpcomingInstancesCron = () => {
  cron.schedule(
    "*/10 * * * * *",
    () => {
      generateUpcomingFmsInstanceTasks();
    },
    { timezone: "Asia/Kolkata" },
  );

  console.log("🔄 FMS Upcoming Instances Cron scheduled ✅");
};

export default startFmsUpcomingInstancesCron;
