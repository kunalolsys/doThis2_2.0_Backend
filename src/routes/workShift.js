
import express from "express";
const router = express.Router();
import * as workShiftController from "../controllers/workShiftController.js";

router.post("/list", workShiftController.getAllWorkShifts);
router.get("/getAllWorkShifts", workShiftController.getAllShiftsForDrops);
router.post("/export", workShiftController.exportWorkShifts);
router.post("/", workShiftController.createWorkShift);
router.get("/:id", workShiftController.getWorkShiftById);
router.put("/:id", workShiftController.updateWorkShift);
router.delete("/:id", workShiftController.deleteWorkShift);

export default router;
