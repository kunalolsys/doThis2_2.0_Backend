import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import upload from '../middleware/upload.js';
import * as fmsTemplateController from '../controllers/fmsTemplateController.js';
import * as fmsTaskController from '../controllers/fmsTaskController.js';
import * as fmsInstanceController from '../controllers/fmsInstanceController.js';
// import * as fmsInstanceHistoryController from '../controllers/fmsInstanceHistoryController.js';

const router = express.Router();

// BRD 5.1 Template Management (PERFECTED)
router.post('/templates',  fmsTemplateController.createTemplate);
router.post('/templates-list',  fmsTemplateController.getTemplates);
router.get('/templates-list-drop',  fmsTemplateController.getTemplatesForDropdown);
router.get('/templates-details/:id',  fmsTemplateController.getTemplateById);
router.put('/templates/:id',  fmsTemplateController.updateTemplate);
router.delete('/templates/:id',  fmsTemplateController.deleteTemplate);
router.post('/templates/:id/tasks-list',  fmsTemplateController.getTemplateTasks);

// BRD 5.2 Template Tasks (Bulk + Single) - FIXED ROUTES
router.post('/templates/:id/tasks',  upload.array('files'), fmsTaskController.createFmsTasks);
router.get('/fms-templates/:id/tasks',  fmsTaskController.getFmsTasksByTemplate);
router.put('/templates/:id/tasks/:taskId',  fmsTaskController.updateFmsTask);
router.post('/templates/:id/tasks/import', upload.single('file'), fmsTaskController.importFmsTasksUniversal);
router.delete('/templates/:id/tasks/:taskId',  fmsTaskController.deleteFmsTask);

// BRD 002.2 Launch & Runtime
router.post('/instances/:templateId/launch',  fmsInstanceController.launchFmsInstance);
router.get('/instances',  fmsInstanceController.getFmsInstances);
router.get('/instances/:id',  fmsInstanceController.getFmsInstanceById);
router.get('/instances/:id/tasks',  fmsInstanceController.getInstanceTasks);
router.patch('/instances/:id/tasks/:taskId',  fmsInstanceController.updateFmsInstanceTask);
router.put('/instances/:id/tasks/:taskId/complete',  fmsInstanceController.completeInstanceTask);

// router.patch('/instances/:id/tasks/:taskId/checklist/:index',  fmsInstanceController.updateChecklistItem);
// router.patch('/instances/:id/tasks/:taskId/formData',  fmsInstanceController.updateFormData);
// router.patch('/instances/:id/tasks/:taskId/status',  fmsInstanceController.updateTaskStatus);

// NEW: Instance Control + History
router.put('/instances/:id/stop', authenticateJWT, fmsInstanceController.stopFmsInstance);
// router.get('/instances/:id/history',  fmsInstanceHistoryController.getInstanceHistory);
// router.get('/instances/:id/tasks/:taskId/history', fmsInstanceHistoryController.getInstanceTaskHistory);

export default router;

