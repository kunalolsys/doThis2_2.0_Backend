import express from "express";
import { getMisReport } from "../controllers/misReportController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/report", authenticateJWT, getMisReport);

export default router;
