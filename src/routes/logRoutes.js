import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import { getLogs } from "../controllers/logController.js";

const router = express.Router();

router.get("/", authenticateJWT, getLogs);

export default router;
