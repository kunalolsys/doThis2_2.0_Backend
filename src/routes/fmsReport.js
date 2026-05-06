import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import { getFmsReport } from "../controllers/fmsReportController.js";

const router = express.Router();

router.post("/report", authenticateJWT, getFmsReport);

export default router;

