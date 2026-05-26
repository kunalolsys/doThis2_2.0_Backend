import express from "express";

import {
  createTaskAudienceMaster,
  updateTaskAudienceMaster,
  getTaskAudienceMasters,
} from "../controllers/taskAudienceMasterController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/", authenticateJWT, createTaskAudienceMaster);

router.put("/:id", authenticateJWT, updateTaskAudienceMaster);

router.get("/", authenticateJWT, getTaskAudienceMasters);

export default router;
