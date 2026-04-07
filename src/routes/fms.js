import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import upload from '../middleware/upload.js';
import * as fmsTemplateController from '../controllers/fmsTemplateController.js';
import * as fmsTaskController from '../controllers/fmsTaskController.js';
import * as fmsInstanceController from '../controllers/fmsInstanceController.js';
import * as fmsInstanceHistoryController from '../controllers/fmsInstanceHistoryController.js';

const router = express.Router();

// BRD 5.1 Template Management (PERFECTED)
router.post('/templates',  fmsTemplateController.createTemplate);
router.get('/templates',  fmsTemplateController.getTemplates);
router.get('/templates/:id',  fmsTemplateController.getTemplateById);
router.put('/templates/:id',  fmsTemplateController.updateTemplate);
router.delete('/templates/:id',  fmsTemplateController.deleteTemplate);
router.get('/templates/:id/tasks',  fmsTemplateController.getTemplateTasks);

// BRD 5.2 Template Tasks (Bulk + Single) - FIXED ROUTES
router.post('/templates/:id/tasks',  upload.array('files'), fmsTaskController.createFmsTasks);
router.get('/templates/:id/tasks',  fmsTaskController.getFmsTasksByTemplate);
// router.put('/templates/:id/tasks/:taskId',  fmsTaskController.updateFmsTask);
// router.delete('/templates/:id/tasks/:taskId',  fmsTaskController.deleteFmsTask);

// BRD 002.2 Launch & Runtime
router.post('/instances/:templateId/launch',  fmsInstanceController.launchFmsInstance);
router.get('/instances',  fmsInstanceController.getFmsInstances);
router.get('/instances/:id',  fmsInstanceController.getFmsInstanceById);
router.get('/instances/:id/tasks',  fmsInstanceController.getInstanceTasks);
router.put('/instances/:id/tasks/:taskId/complete',  fmsInstanceController.completeInstanceTask);

// NEW: Instance Control + History
router.put('/instances/:id/stop', authenticateJWT, fmsInstanceController.stopFmsInstance);
router.get('/instances/:id/history',  fmsInstanceHistoryController.getInstanceHistory);
router.get('/instances/:id/tasks/:taskId/history', fmsInstanceHistoryController.getInstanceTaskHistory);

export default router;

