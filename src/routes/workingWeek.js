import express from "express";
import {
  getWorkingWeek,
  updateWorkingWeek,
} from "../controllers/workingweekController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";

const router = express.Router();

router
  .route("/")
  .get(authenticateJWT, getWorkingWeek)
  .patch(authenticateJWT, updateWorkingWeek);

export default router;
