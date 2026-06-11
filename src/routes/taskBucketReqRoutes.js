import express from "express";
import {
    convertTaskBucketRequest,
  getTaskBucketRequests,
  submitTaskBucketRequest,
  updateTaskBucketRequest,
} from "../controllers/taskBucketReqController.js";
const router = express.Router();
router.post("/submit", submitTaskBucketRequest);
router.get("/responses", getTaskBucketRequests);
router.put("/:id", updateTaskBucketRequest);
router.put("/:id/convert", convertTaskBucketRequest);
export default router;
