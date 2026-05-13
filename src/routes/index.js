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
import { moduleGate } from "../middleware/moduleGate.js";

const router = express.Router();

// NOTE: moduleGate blocks disabled modules for non-super users.
router.use("/setup", moduleGate, setupRoutes);

router.use("/auth", authRoutes);

router.use("/work-shifts", moduleGate, workShiftRoutes);

// task routes
router.use("/tasks", moduleGate, taskRoutes);

// user routes (usually not gated, but leaving ungated is fine)
router.use("/users", userRoutes);
router.use("/logs", logsRoutes);

router.use("/mis", moduleGate, misReportRoutes);

router.use("/schedule-holiday-task", moduleGate, scheduleHolidayTaskRoutes);
router.use("/fms", moduleGate, fmsRoutes);
router.use("/fms-report", moduleGate, fmsReportRoutes);
router.use("/queries", moduleGate, queriesRoutes);
router.use("/thread", threadRoutes);
router.use("/uploads", express.static("uploads"));
router.use("/company",moduleGate, companyProfileRoutes);
export default router;
