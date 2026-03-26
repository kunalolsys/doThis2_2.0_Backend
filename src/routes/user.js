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

const router = express.Router();

router.post("/", createUser);
router.post("/list", getAllUsers);
router.get("/allUsers", getAllUserForDrops);
router.get("/:id", getSingleUser);
router.put("/:id", updateUser);
router.delete("/:id", deleteUser);
router.post("/export", exportUsers);

export default router;
