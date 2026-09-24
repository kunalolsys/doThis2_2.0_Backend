import express from "express";
import { getMisReport } from "../controllers/misReportController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import { getCombinedReport } from "../controllers/reportController.js";

const router = express.Router();

router.post("/report", authenticateJWT, getMisReport);
router.post("/combined-report", authenticateJWT, getCombinedReport);
export default router;
