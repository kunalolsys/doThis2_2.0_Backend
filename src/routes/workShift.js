import express from "express";
const router = express.Router();
import * as workShiftController from "../controllers/workShiftController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";

router.post("/list", authenticateJWT, workShiftController.getAllWorkShifts);
router.get(
  "/getAllWorkShifts",
  authenticateJWT,
  workShiftController.getAllShiftsForDrops,
);
router.post("/export", authenticateJWT, workShiftController.exportWorkShifts);
router.post("/", authenticateJWT, workShiftController.createWorkShift);
router.get("/:id", authenticateJWT, workShiftController.getWorkShiftById);
router.put("/:id", authenticateJWT, workShiftController.updateWorkShift);
router.delete("/:id", authenticateJWT, workShiftController.deleteWorkShift);

export default router;
