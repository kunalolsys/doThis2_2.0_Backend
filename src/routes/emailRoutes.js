// routes/testEmailRoute.js

import express from "express";
import { sendTestEmail } from "../services/testEmail.js";

const router = express.Router();

router.get("/test-email", async (req, res) => {
  try {
    const result = await sendTestEmail("hemant@openlogicsys.com");

    res.status(200).json({
      success: true,
      message: "Test email sent",
      messageId: result.messageId,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

export default router;
