import express from "express";
import {
  raiseQuery,
  replyToQuery,
  getTaskQueries,
  getRaisedQueries,
  getAssignedQueries,
} from "../controllers/queries/queryController.js";
import { authenticateJWT } from "../middleware/auth.js";

const router = express.Router();

router.post("/raise", authenticateJWT, raiseQuery);
router.post("/reply", authenticateJWT, replyToQuery);
router.get("/task/:taskId", authenticateJWT, getTaskQueries);
router.get("/raised", authenticateJWT, getRaisedQueries);
router.get("/assigned-to-me", authenticateJWT, getAssignedQueries);

export default router;
