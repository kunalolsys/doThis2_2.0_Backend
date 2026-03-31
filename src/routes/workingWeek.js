import express from "express";
import {
  // getWorkingWeeks,
  getWorkingWeek,
  updateWorkingWeek,
} from "../controllers/workingweekController.js";

const router = express.Router();

// router.route("/").get(getWorkingWeeks);
router.route("/").get(getWorkingWeek).patch(updateWorkingWeek);

export default router;
