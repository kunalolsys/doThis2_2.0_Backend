import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import { createOpenForm, getAllOpenForms, getOpenForm, submitOpenForm, updateOpenForm } from "../controllers/openFormController.js";

const router = express.Router();

router.post("/", authenticateJWT, createOpenForm);
router.get("/", authenticateJWT, getAllOpenForms);
router.post("/:id/submit", authenticateJWT, submitOpenForm);
router.get("/:id", authenticateJWT, getOpenForm);
router.put("/:id", authenticateJWT, updateOpenForm);

export default router;
