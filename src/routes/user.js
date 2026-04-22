import express from "express";
import {
  createUser,
  getAllUsers,
  getSingleUser,
  updateUser,
  deleteUser,
  exportUsers,
  getAllUserForDrops,
} from "../controllers/userController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/", authenticateJWT, createUser);
router.post("/list", authenticateJWT, getAllUsers);
router.get("/allUsers", authenticateJWT, getAllUserForDrops);
router.get("/:id", authenticateJWT, getSingleUser);
router.put("/:id", authenticateJWT, updateUser);
router.delete("/:id", authenticateJWT, deleteUser);
router.post("/export", authenticateJWT, exportUsers);

export default router;
