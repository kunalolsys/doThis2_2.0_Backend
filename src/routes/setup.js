import express from "express";
import * as departmentController from "../controllers/departmentController.js";
import * as workShiftController from "../controllers/workShiftController.js";
import * as userController from "../controllers/userController.js";
import * as roleController from "../controllers/roleController.js";
import {
  createHoliday,
  getAllHolidays,
  getHoliday,
  updateHoliday,
  deleteHoliday,
  exportHolidays,
  getAllHolidaysForDrops,
} from "../controllers/holidayController.js";
import { authenticateJWT } from "../middleware/authMiddleware.js";
import userRoutes from "./user.js";
import workingWeekRoutes from "./workingWeek.js";
import moduleSettingRoutes from "./moduleSetting.js";

const router = express.Router();

router.get("/roles", roleController.getAllRoles);
router.post("/roles", roleController.createRole);
router.put("/roles/:id", roleController.updateRole);
router.delete("/roles/:id", roleController.deleteRole);
router.get("/roles/my-permissions", authenticateJWT, roleController.getMyPermissions);

router.post(
  "/departments/list",
  authenticateJWT,
  departmentController.getAllDepartment,
);
router.post(
  "/departments/export",
  authenticateJWT,
  departmentController.exportDepartment,
);
router.get(
  "/departments/allDepartments",
  authenticateJWT,
  departmentController.getAllDeptsForDrops,
);
router.get(
  "/departments/allDepartmentsForFMS",
  authenticateJWT,
  departmentController.getAllDeptsForDropsForFMS,
);
router.post(
  "/departments",
  authenticateJWT,
  departmentController.createDepartment,
);
router.put(
  "/departments/:id",
  authenticateJWT,
  departmentController.updateDepartment,
);
router.delete(
  "/departments/:id",
  authenticateJWT,
  departmentController.deleteDepartment,
);

router.use("/users", userRoutes);
router.post("/holiday/list", authenticateJWT, getAllHolidays);
router.post("/holiday/export", authenticateJWT, exportHolidays);
router.get("/holiday/allHolidays", authenticateJWT, getAllHolidaysForDrops);
router.post("/holiday", authenticateJWT, createHoliday);
router
  .route("/holiday/:id")
  .get(getHoliday)
  .patch(updateHoliday)
  .delete(deleteHoliday);

router.use("/working-week", workingWeekRoutes);

router.use("/modules", moduleSettingRoutes);

export default router;
