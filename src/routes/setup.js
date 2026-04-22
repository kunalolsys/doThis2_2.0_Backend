import express from "express"
const router = express.Router();
import * as departmentController from "../controllers/departmentController.js";
import * as workShiftController from "../controllers/workShiftController.js";
import * as userController from "../controllers/userController.js";import * as roleController from "../controllers/roleController.js";
router.get("/roles", roleController.getAllRoles);
router.post("/roles", roleController.createRole);
router.put("/roles/:id", roleController.updateRole);
router.delete("/roles/:id", roleController.deleteRole);

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

router.post("/departments/list",authenticateJWT, departmentController.getAllDepartment);
router.post("/departments/export",authenticateJWT, departmentController.exportDepartment);
router.get("/departments/allDepartments",authenticateJWT, departmentController.getAllDeptsForDrops);
router.post("/departments",authenticateJWT, departmentController.createDepartment);
router.put("/departments/:id", authenticateJWT,departmentController.updateDepartment);
router.delete("/departments/:id", authenticateJWT,departmentController.deleteDepartment);

// router.get("/work-shifts", workShiftController.getAllWorkShifts);
// router.post("/work-shifts", workShiftController.createWorkShift);
// router.put("/work-shifts/:id", workShiftController.updateWorkShift);
// router.delete("/work-shifts/:id", workShiftController.deleteWorkShift);

router.use("/users", userRoutes);

// Get current logged-in user
// router.get('/currentUser', authenticateJWT, userController.getSingleUser);
router.post('/holiday/list',authenticateJWT, getAllHolidays);
router.post('/holiday/export', authenticateJWT,exportHolidays);
router.get('/holiday/allHolidays',authenticateJWT, getAllHolidaysForDrops);
router.post('/holiday',authenticateJWT, createHoliday);
// router.route('/holiday').get(getAllHolidays).post(createHoliday);
router.route('/holiday/:id').get(getHoliday).patch(updateHoliday).delete(deleteHoliday);

router.use("/working-week", workingWeekRoutes);

export default router;