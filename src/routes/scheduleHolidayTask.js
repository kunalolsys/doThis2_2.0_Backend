import express from "express";
import {
  createScheduleHolidayTask,
  getScheduleHolidayTask,
} from "../controllers/scheduleHolidayTaskController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/", authenticateJWT, createScheduleHolidayTask);
router.get("/", authenticateJWT, getScheduleHolidayTask);

export default router;
