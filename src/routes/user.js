import express from "express";
import {
  createUser,
  getAllUsers,
  getSingleUser,
  updateUser,
  deleteUser,
  exportUsers,
  getAllUserForDrops,
  getAllUsersForDrop,
  dashboardUserCount,
  getAllFilterUserForDrops,
} from "../controllers/userController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import upload from "../services/Upload.js";

const router = express.Router();

router.post("/", authenticateJWT, createUser);
router.post("/list", authenticateJWT, getAllUsers);
router.get("/list-drop", authenticateJWT, getAllUsersForDrop);
router.get("/user-count", authenticateJWT, dashboardUserCount);
router.get("/allUsers", authenticateJWT, getAllUserForDrops);
router.get("/filter-allUsers", authenticateJWT, getAllFilterUserForDrops);
router.get("/:id", authenticateJWT, getSingleUser);
router.put(
  "/:id",
  upload.fields([
    { name: "profilePhoto", maxCount: 1 },
  ]),
  authenticateJWT,
  updateUser,
);
router.delete("/:id", authenticateJWT, deleteUser);
router.post("/export", authenticateJWT, exportUsers);

export default router;
