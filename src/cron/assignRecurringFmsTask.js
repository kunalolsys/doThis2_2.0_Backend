import cron from "node-cron";
import moment from "moment-timezone";
import FmsInstance from "../models/FmsInstance.js";
import FmsInstanceTask from "../models/FmsInstanceTask.js";
import FmsTask from "../models/FmsTask.js";
import User from "../models/User.js";
import {
  addWorkingDaysHoliday,
  nextWorkingShiftDate,
  snapToShiftTime,
  isWorkingDay as checkIsWorkingDay,
  isHoliday,
} from "../utils/dateCalculator.js";
import { format } from "date-fns";
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
      console.error(`[Telegram Error] Task ${task.taskId}:`, e.message),
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
        console.error(`[Email Error] Task ${task.taskId}:`, e.message),
      );
    }
  } catch (err) {
    console.error(
      `[Notification Handler Warning] Task ${task?.taskId}:`,
      err.message,
    );
  }
};

const isTaskDueToday = async (task, instance) => {
  try {
    const today = moment().tz("Asia/Kolkata").startOf("day");
    const start = moment(instance.startDate).tz("Asia/Kolkata").startOf("day");

    if (today.isBefore(start)) return false;

    const end = instance.endDate
      ? moment(instance.endDate).tz("Asia/Kolkata").endOf("day")
      : null;
    if (end && today.isAfter(end)) return false;

    const todayDate = today.toDate();

    // 🔥 DEPT ID PASSED INSTEAD OF USER ID
    const deptId = task.departmentOfAssignToUser || task.assignedTo;

    // Parallelize working day and holiday check to cut DB query latency in half
    const [isWorking, holiday] = await Promise.all([
      checkIsWorkingDay(todayDate, null, deptId),
      isHoliday(todayDate, deptId),
    ]);

    if (holiday || !isWorking) return false;

    const todayDay = today.format("dddd").toLowerCase();
    switch (task.frequency) {
      case "Daily":
      case "Anytime":
        return true;

      case "Weekly":
        return todayDay === start.format("dddd").toLowerCase();

      case "Monthly": {
        const startDateNum = start.date();
        const expected = today.clone().date(startDateNum);
        if (!expected.isValid()) expected.date(1);
        return today.isSame(expected, "day");
      }

      default:
        return false;
    }
  } catch (err) {
    console.error(`Error checking due status for task ${task?.taskId}:`, err);
    return false;
  }
};

export const generateDependentChildren = async (
  instance,
  parentInstanceTask,
  parentTemplateTask,
) => {
  try {
    const children = await FmsTask.find({
      dependentOn: parentTemplateTask.taskId,
      isDependent: true,
    }).lean();

    if (!children.length) return;

    const assignedParentUser = await User.findById(
      parentInstanceTask.assignedTo,
    )
      .populate("assignShift")
      .lean();

    if (!assignedParentUser) {
      console.error(
        `User ID ${parentInstanceTask.assignedTo} not found for parent task.`,
      );
      return;
    }

    const parentWorkShift = assignedParentUser.assignShift;

    for (const childTemplate of children) {
      try {
        const alreadyExists = await FmsInstanceTask.exists({
          fmsInstanceId: instance._id,
          fmsTaskId: childTemplate._id,
          dependentOn: parentInstanceTask.taskId,
          recurrenceKey: parentInstanceTask.recurrenceKey,
        });

        if (alreadyExists) continue;

        // Optimized single roundtrip query for doer, assigner, and recipient
        const [doer, assignedByUser, assignedToUser] = await Promise.all([
          User.findById(childTemplate.assignedTo)
            .populate("assignShift")
            .lean(),
          User.findById(childTemplate.assignedBy).select("name email").lean(),
          User.findById(childTemplate.assignedTo).select("name email").lean(),
        ]);

        const parentStart = parentInstanceTask.plannedStartDate;
        const parentDue = parentInstanceTask.plannedDueDate;
        if (!parentStart || !parentDue) continue;

        let startDate = new Date(parentStart);
        let dueDate = new Date(parentDue);

        const isSameShift =
          String(doer?.assignShift?._id) === String(parentWorkShift?._id);

        // 🔥 CHILD DEPT ID PASSED INSTEAD OF USER ID
        const childDeptId =
          childTemplate.departmentOfAssignToUser || childTemplate.assignedTo;

        if (!isSameShift && doer?.assignShift) {
          const start = await nextWorkingShiftDate(
            new Date(parentStart),
            doer.assignShift._id,
            {},
            childDeptId,
          );

          startDate = snapToShiftTime(start, doer.assignShift, true);
          dueDate = snapToShiftTime(start, doer.assignShift, false);
        } else if (doer?.assignShift) {
          const x = Number(childTemplate.xValue || 0);
          const freq = (childTemplate.frequency || "").toLowerCase();

          if (freq.includes("hour")) {
            let calculatedDue = new Date(parentDue);
            calculatedDue.setHours(calculatedDue.getHours() + x);

            const shiftEnd = snapToShiftTime(
              parentDue,
              doer.assignShift,
              false,
            );

            if (calculatedDue < shiftEnd) {
              dueDate = calculatedDue;
            } else {
              const overflowMs = calculatedDue.getTime() - shiftEnd.getTime();
              let nextDay = new Date(parentDue);
              nextDay.setDate(nextDay.getDate() + 1);

              const nextWorkingDay = await nextWorkingShiftDate(
                nextDay,
                doer.assignShift._id,
                {},
                childDeptId,
              );

              const nextShiftStart = snapToShiftTime(
                nextWorkingDay,
                doer.assignShift,
                true,
              );
              dueDate = new Date(nextShiftStart.getTime() + overflowMs);
            }
          } else {
            dueDate = await addWorkingDaysHoliday(
              parentDue,
              x,
              doer.assignShift._id,
              false,
              {},
              childDeptId,
            );

            if (dueDate) {
              dueDate.setHours(
                parentDue.getHours(),
                parentDue.getMinutes(),
                parentDue.getSeconds(),
                parentDue.getMilliseconds(),
              );

              const shiftEnd = snapToShiftTime(
                dueDate,
                doer.assignShift,
                false,
              );
              if (dueDate >= shiftEnd) {
                let nextDay = new Date(dueDate);
                nextDay.setDate(nextDay.getDate() + 1);

                const nextWorkingDay = await nextWorkingShiftDate(
                  nextDay,
                  doer.assignShift._id,
                  {},
                  childDeptId,
                );

                dueDate = snapToShiftTime(
                  nextWorkingDay,
                  doer.assignShift,
                  false,
                );
              }
            }
          }
        }

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
          recurrenceKey: parentInstanceTask.recurrenceKey,
          startTimeSetting: childTemplate.startTimeSetting,

          plannedStartDate:
            childTemplate.startTimeSetting === "actual-to-planned"
              ? null
              : startDate,
          plannedDueDate:
            childTemplate.startTimeSetting === "actual-to-planned"
              ? null
              : dueDate,

          status: "Pending",
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
        });

        console.log(`✅ Generated child ${childInstanceTask.taskId}`);

        // Async non-blocking dispatch
        safeSendNotifications({
          task: childInstanceTask,
          actor: assignedByUser,
          recipient: assignedToUser,
        });

        // Recurse for multi-level child dependencies
        await generateDependentChildren(
          instance,
          childInstanceTask,
          childTemplate,
        );
      } catch (childErr) {
        console.error(
          `❌ Error generating child task for template ${childTemplate?._id}:`,
          childErr,
        );
      }
    }
  } catch (err) {
    console.error("❌ Critical Error in generateDependentChildren:", err);
  }
};

export const generateRecurringFmsTasks = async (instanceId = null) => {
  console.log(
    "\n🚀 FMS CRON - Started at:",
    new Date().toLocaleString("en-IN"),
  );

  try {
    const query = instanceId
      ? { _id: instanceId, triggerType: { $ne: "FORM_SUBMISSION" } } // 🟢 Exclude FORM_SUBMISSION on direct call
      : {
          status: { $nin: ["Onhold", "Stopped", "Completed", "Cancelled"] },
          isStopped: false,
          triggerType: { $ne: "FORM_SUBMISSION" }, // 🟢 Exclude FORM_SUBMISSION during scheduled cron run
        };

    const instances = await FmsInstance.find(query)
      .populate("fmsTemplateId")
      .lean();

    if (!instances.length) {
      console.log(
        "ℹ️ No eligible active FMS instances found for recurring generation.",
      );
      return;
    }

    let createdCount = 0;

    for (const instance of instances) {
      try {
        // 🟢 Double-check triggerType guard at the instance iteration level
        if (instance.triggerType === "FORM_SUBMISSION") {
          console.log(
            `⏭️ Skipping form-triggered instance: ${instance.instanceId}`,
          );
          continue;
        }

        if (!instance.fmsTemplateId?._id) continue;

        console.log(`\n📂 Processing FMS Instance: ${instance.instanceId}`);

        const tasks = await FmsTask.find({
          fmsTemplateId: instance.fmsTemplateId._id,
          frequency: { $in: ["Daily", "Weekly", "Monthly"] },
        }).lean();

        for (const task of tasks) {
          try {
            if (!(await isTaskDueToday(task, instance))) continue;

            const recurrenceKey = moment()
              .tz("Asia/Kolkata")
              .format("YYYY-MM-DD");

            // Efficient lightweight existence check
            const duplicateExists = await FmsInstanceTask.exists({
              fmsInstanceId: instance._id,
              fmsTaskId: task._id,
              recurrenceKey,
            });

            if (duplicateExists) {
              console.log(
                `⚠️ Skip duplicate: ${task.taskId} [Key: ${recurrenceKey}]`,
              );
              continue;
            }

            // Parallel user details fetch
            const [user, assignedByUser, assignedToUser] = await Promise.all([
              User.findById(task.assignedTo).populate("assignShift").lean(),
              User.findById(task.assignedBy).select("name email").lean(),
              User.findById(task.assignedTo).select("name email").lean(),
            ]);

            if (!user?.assignShift) {
              console.log(
                `⚠️ User or WorkShift missing for task ${task.taskId}`,
              );
              continue;
            }

            // 🔥 DEPT ID PASSED INSTEAD OF USER ID
            const taskDeptId = task.departmentOfAssignToUser || task.assignedTo;

            const shiftStart = await nextWorkingShiftDate(
              new Date(),
              user.assignShift._id,
              {},
              taskDeptId,
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

            // Process dependent tasks
            await generateDependentChildren(instance, parentInstanceTask, task);

            // Dispatch notifications safely without blocking execution flow
            safeSendNotifications({
              task: parentInstanceTask,
              actor: assignedByUser,
              recipient: assignedToUser,
            });

            console.log(
              `✅ Generated Task: ${task.taskId} | ${format(shiftStart, "HH:mm dd-MM")} -> ${format(shiftEnd, "HH:mm")}`,
            );
          } catch (taskErr) {
            console.error(
              `❌ Task Level Processing Error [${task?.taskId}]:`,
              taskErr,
            );
          }
        }
      } catch (instanceErr) {
        console.error(
          `❌ Instance Level Error [${instance?.instanceId}]:`,
          instanceErr,
        );
      }
    }

    console.log(`\n📊 TOTAL COMPLETED: ${createdCount} tasks created.`);
  } catch (globalErr) {
    console.error("💥 Fatal FMS Cron Execution Error:", globalErr);
  }
};

const startRecurringFmsTaskJob = () => {
  console.log("🔄 FMS Cron Job Initialized");

  // Daily run at 09:00 AM IST
  cron.schedule(
    "0 9 * * *",
    () => {
      generateRecurringFmsTasks(null);
    },
    {
      timezone: "Asia/Kolkata",
    },
  );
};

export default startRecurringFmsTaskJob;
