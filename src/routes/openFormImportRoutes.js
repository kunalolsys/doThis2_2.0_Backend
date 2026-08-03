import { Router } from "express";
import multer from "multer";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import {
  downloadImportTemplate,
  bulkImportFormSubmissions,
} from "../controllers/openFormImportController.js";

const router = Router();
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
    ];
    cb(
      null,
      allowed.includes(file.mimetype) || file.originalname.endsWith(".csv"),
    );
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// GET  /api/open-forms/:slug/import-template   → download blank XLSX
router.get("/:slug/import-template", authenticateJWT, downloadImportTemplate);

// POST /api/open-forms/:slug/import            → upload filled XLSX/CSV
router.post(
  "/:slug/import",
  authenticateJWT,
  upload.single("file"),
  bulkImportFormSubmissions,
);

export default router;
