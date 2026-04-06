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
const router = express.Router();

router.use("/setup", setupRoutes);

router.use("/auth", authRoutes);

router.use("/work-shifts", workShiftRoutes);

// import workingWeekRoutes from "./workingWeek.js";
// router.use("/working-weeks", workingWeekRoutes);

// task routes
router.use("/tasks", taskRoutes);

// user routes
router.use("/users", userRoutes);
router.use("/logs", logsRoutes);

router.use("/mis", misReportRoutes);

router.use("/schedule-holiday-task", scheduleHolidayTaskRoutes);
router.use("/fms", fmsRoutes);

export default router;
