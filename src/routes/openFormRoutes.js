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

const router = express.Router();

router.post("/", authenticateJWT, createOpenForm);
router.post("/get-forms", authenticateJWT, getAllOpenForms);
router.put("/:id", authenticateJWT, updateOpenForm);

//**PUBLIC API TO VARIFY USER VIA EMPLOYEE CODE */
router.post("/verify-user", verifyOpenFormUser);
router.get("/:slug", getOpenForm);
router.post("/:slug/submit", submitOpenForm);

//**GET FORM SUBMISSION */
router.get("/:formId/submissions", authenticateJWT, getFormSubmissions);
router.delete("/:formId", authenticateJWT, deleteOpenForm);

router.get("/submission/:id", authenticateJWT, getSubmissionDetails);
export default router;
