// routes/taskBucketRoutes.js

import express from "express";

import {
  createTaskBucket,
  getTaskBuckets,
  getSingleTaskBucket,
  distributeTaskBucket,
  deleteTaskBucket,
  getBucketReportingUsers,
} from "../controllers/taskBucketController.js";

import { authenticateJWT } from "../middleware/authMiddleware.js";
import upload from "../middleware/upload.js";
const router = express.Router();

router.post(
  "/",
  authenticateJWT,
  upload.array("attachmentFile"),
  createTaskBucket,
);

router.get("/", authenticateJWT, getTaskBuckets);

router.get("/:id", authenticateJWT, getSingleTaskBucket);

router.post("/:id/distribute", authenticateJWT, distributeTaskBucket);

router.delete("/:id", authenticateJWT, deleteTaskBucket);
router.get("/:id/reporting-users", authenticateJWT, getBucketReportingUsers);
export default router;
