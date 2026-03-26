import express from 'express';
import { login, logout, forgotPassword, resetPassword, registerEmail } from '../controllers/authController.js';

const router = express.Router();

router.post('/login', login);
router.post('/logout', logout);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/register-email', registerEmail);

export default router;
