import express from "express";
import setupRoutes from "./setup.js";
import authRoutes from "./auth.js";
import workShiftRoutes from "./workShift.js";
import taskRoutes from "./task.js";
import userRoutes from "./user.js";
import logsRoutes from "./logRoutes.js";
import scheduleHolidayTaskRoutes from "./scheduleHolidayTask.js";
import misReportRoutes from "./misReport.js";
import fmsRoutes from "./fms.js";
import queriesRoutes from "./queries.js";
import threadRoutes from "./thread.js";
import fmsReportRoutes from "./fmsReport.js";
import companyProfileRoutes from "./CompanyRoutes.js";
import openFormRoutes from "./openFormRoutes.js";
import taskBucketsRoutes from "./taskBucketRoutes.js";
import taskAudienceMastersRoutes from "./taskAudienceMasterRoutes.js";
import emailRoutes from "./emailRoutes.js";
import taskBucketsReqRoutes from "./taskBucketReqRoutes.js";
import decisionRoutes from "./decisionStepRoutes.js";
import { moduleGate } from "../middleware/moduleGate.js";

const router = express.Router();

router.use("/setup", moduleGate, setupRoutes);

router.use("/auth", authRoutes);

router.use("/work-shifts", moduleGate, workShiftRoutes);

router.use("/tasks", moduleGate, taskRoutes);

router.use("/users", userRoutes);

router.use("/logs", logsRoutes);

router.use("/mis", moduleGate, misReportRoutes);

router.use("/schedule-holiday-task", moduleGate, scheduleHolidayTaskRoutes);

router.use("/fms", moduleGate, fmsRoutes);

router.use("/fms-report", moduleGate, fmsReportRoutes);

router.use("/queries", moduleGate, queriesRoutes);

router.use("/thread", threadRoutes);

router.use("/uploads", express.static("uploads"));

router.use("/company", moduleGate, companyProfileRoutes);

router.use("/open-forms", openFormRoutes);

router.use("/task-buckets", taskBucketsRoutes);

router.use("/task-audience-masters", taskAudienceMastersRoutes);

router.use("/email", emailRoutes);
router.use("/task-buckets-req", taskBucketsReqRoutes);
router.use("/fms-decision", decisionRoutes);

export default router;
