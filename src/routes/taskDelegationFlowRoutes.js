import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import {
  assignFinalWorker,
  forwardTask,
  getDistributionInbox,
  getTaskFlowHistory,
} from "../controllers/taskDistributionController.js";

const router = express.Router();

router.get("/distribution/inbox", authenticateJWT, getDistributionInbox);

router.post("/:id/forward", authenticateJWT, forwardTask);

router.post("/:id/assign-final", authenticateJWT, assignFinalWorker);

router.get("/:id/flow-history", authenticateJWT, getTaskFlowHistory);
