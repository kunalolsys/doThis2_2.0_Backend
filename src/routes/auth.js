import express from "express";
import {
  forgotPassword,
  resetPassword,
  registerEmail,
} from "../controllers/authController.js";
import { login, logout, refresh } from "../controllers/loginController.js";

const router = express.Router();

// router.post('/login', login);
// router.post('/logout', logout);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/register-email", registerEmail);

//**NEW FUNCTION */
router.post("/login", login);
router.post("/logout", logout);
router.get("/refresh", refresh);

export default router;
