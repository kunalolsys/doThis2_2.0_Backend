import express from "express";
import {
  // getWorkingWeeks,
  getWorkingWeek,
  updateWorkingWeek,
} from "../controllers/workingweekController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";

const router = express.Router();

// router.route("/").get(getWorkingWeeks);
router
  .route("/")
  .get(authenticateJWT, getWorkingWeek)
  .patch(authenticateJWT, updateWorkingWeek);

export default router;
