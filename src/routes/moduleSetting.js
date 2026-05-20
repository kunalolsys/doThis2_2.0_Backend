import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import { requirePermission } from "../middleware/requirePermission.js";

import * as moduleSettingController from "../controllers/moduleSettingController.js";

const router = express.Router();

router.get("/list", authenticateJWT, moduleSettingController.listModules);
router.post(
  "/toggle",
  authenticateJWT,
  moduleSettingController.upsertModuleSetting,
);

export default router;
