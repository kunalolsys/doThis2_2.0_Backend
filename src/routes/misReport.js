import express from 'express';
import { getMisReport } from '../controllers/misReportController.js';

const router = express.Router();

router.post('/report', getMisReport);  // Add authorizeRoles if needed e.g. 'Admin,Sr. Manager'

export default router;
