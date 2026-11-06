import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import {
  getEligibleTasksForExtension,
  getMasterConfig,
  getPendingExtensionRequests,
  requestTaskExtension,
  reviewExtensionRequest,
  updateMasterConfig,
} from "../controllers/taskExtensionController.js";

const router = express.Router();
router
  .route("/master")
  .get(getMasterConfig)
  .post(authenticateJWT, updateMasterConfig);

// ── User Specific Routes ───────────────────────────────────────────────────────
router.get(
  "/user-eligible-tasks",
  authenticateJWT,
  getEligibleTasksForExtension,
);
router.post("/request", authenticateJWT, requestTaskExtension);

// ── Admin / Reporting Manager Review Routes ────────────────────────────────────
router.get("/pending-requests", authenticateJWT, getPendingExtensionRequests);

router.post("/review", authenticateJWT, reviewExtensionRequest);

export default router;
