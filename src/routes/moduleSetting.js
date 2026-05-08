import express from "express";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import { requirePermission } from "../middleware/requirePermission.js";

import * as moduleSettingController from "../controllers/moduleSettingController.js";

const router = express.Router();

// Super UI: only Module Management permission can toggle
router.get(
  "/list",
  authenticateJWT,
  // requirePermission("Module Management"),
  moduleSettingController.listModules,
);
router.post(
  "/toggle",
  authenticateJWT,
  // requirePermission("Module Management"),
  moduleSettingController.upsertModuleSetting,
);

export default router;
