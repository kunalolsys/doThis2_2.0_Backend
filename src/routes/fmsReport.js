import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import { getFmsReport } from "../controllers/fmsReportController.js";
import { getUnifiedTaskFullAudit } from "../controllers/getUnifiedTaskFullAudit.js";

const router = express.Router();

router.post("/report", authenticateJWT, getFmsReport);
router.post("/unified-audit", authenticateJWT, getUnifiedTaskFullAudit);

export default router;

