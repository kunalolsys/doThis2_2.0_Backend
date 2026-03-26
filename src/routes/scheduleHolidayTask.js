import express from 'express';
import { createScheduleHolidayTask, getScheduleHolidayTask } from '../controllers/scheduleHolidayTaskController.js';

const router = express.Router();

router.post('/', createScheduleHolidayTask);
router.get('/', getScheduleHolidayTask);

export default router;