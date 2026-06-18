// routes/taskBucketRoutes.js

import express from "express";

import {
  createTaskBucket,
  getTaskBuckets,
  getSingleTaskBucket,
  distributeTaskBucket,
  deleteTaskBucket,
  getBucketReportingUsers,
  completeTaskBucket,
  getAllTaskBuckets,
  updateTaskBucket,
} from "../controllers/taskBucketController.js";

import { authenticateJWT } from "../middleware/authMiddleware.js";
import upload from "../middleware/upload.js";
import {
  downloadBucketImportTemplate,
  exportPendingTaskBuckets,
  exportTaskBuckets,
  importTaskBuckets,
} from "../services/imports/importBucket.js";
const router = express.Router();
router.post(
  "/import",
  authenticateJWT,
  upload.single("file"),
  importTaskBuckets,
);
router.get("/downloadTemp", authenticateJWT, downloadBucketImportTemplate);

router.post(
  "/",
  authenticateJWT,
  upload.array("attachmentFile"),
  createTaskBucket,
);

router.get("/", authenticateJWT, getTaskBuckets);
router.get("/list", authenticateJWT, getAllTaskBuckets);

router.get("/:id", authenticateJWT, getSingleTaskBucket);

router.post("/:id/distribute", authenticateJWT, distributeTaskBucket);

router.delete("/:id", authenticateJWT, deleteTaskBucket);
router.put(
  "/:id",
  authenticateJWT,
  upload.array("attachmentFile"),
  updateTaskBucket,
);
router.patch("/:id/complete", authenticateJWT, completeTaskBucket);
router.get("/:id/reporting-users", authenticateJWT, getBucketReportingUsers);
router.get("/bucket/export", authenticateJWT, exportTaskBuckets);
router.get("/bucket/export-pending", authenticateJWT, exportPendingTaskBuckets);

export default router;
