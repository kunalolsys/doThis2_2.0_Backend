import { Router } from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import {
  getDecisionInfo,
  submitDecision,
} from "../controllers/decisionStepController.js";

const router = Router();
router.use(authenticateJWT);

router.get("/:taskId/decision-info", getDecisionInfo);
router.post("/:taskId/decision", submitDecision);

export default router;
