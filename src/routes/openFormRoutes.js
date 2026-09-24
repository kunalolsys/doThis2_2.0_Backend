import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import {
  createOpenForm,
  deleteOpenForm,
  getAllOpenForms,
  getFormSubmissions,
  getOpenForm,
  getSubmissionDetails,
  submitOpenForm,
  updateOpenForm,
  verifyOpenFormUser,
} from "../controllers/openFormController.js";
import { updateFormSubmissionResponse } from "../controllers/updateFormSubmissionResponse.js";

const router = express.Router();

router.post("/", authenticateJWT, createOpenForm);
router.post("/get-forms", authenticateJWT, getAllOpenForms);

// 🚀 DIRECT SUBMISSIONS ROUTE (Fixes Express Route Capture)
router.get("/submissions", authenticateJWT, getFormSubmissions);

router.put("/:id", authenticateJWT, updateOpenForm);

// PUBLIC ROUTES
router.post("/verify-user", verifyOpenFormUser);
router.get("/:slug", getOpenForm);
router.post("/:slug/submit", submitOpenForm);

// FORM SUBMISSION ROUTES
router.get("/:formId/submissions", authenticateJWT, getFormSubmissions);
router.delete("/:formId", authenticateJWT, deleteOpenForm);

router.get("/submission/:id", authenticateJWT, getSubmissionDetails);
router.put("/submission/:submissionId/edit", authenticateJWT, updateFormSubmissionResponse); 

export default router;