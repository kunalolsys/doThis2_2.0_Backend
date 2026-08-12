import express from 'express';
import { authenticateJWT } from '../middleware/authMiddleware.js';
import upload from '../middleware/upload.js';
import * as fmsTemplateController from '../controllers/fmsTemplateController.js';
import * as fmsTaskController from '../controllers/fmsTaskController.js';
import * as fmsInstanceController from '../controllers/fmsInstanceController.js';
// import * as fmsInstanceHistoryController from '../controllers/fmsInstanceHistoryController.js';

const router = express.Router();

// BRD 5.1 Template Management (PERFECTED)
router.post('/templates', authenticateJWT, fmsTemplateController.createTemplate);
router.post('/templates-import', authenticateJWT, fmsTemplateController.importFmsTemplates);
router.post('/templates-list', authenticateJWT, fmsTemplateController.getTemplates);
router.post('/templates-list-drop',authenticateJWT,  fmsTemplateController.getTemplatesForDropdown);
router.get('/all-templates',authenticateJWT,  fmsTemplateController.getAllTemplates);
router.get('/templates-details/:id',authenticateJWT,  fmsTemplateController.getTemplateById);
router.put('/templates/:id',authenticateJWT,  fmsTemplateController.updateTemplate);
router.delete('/templates/:id',authenticateJWT,  fmsTemplateController.deleteTemplate);
router.post('/templates/:id/tasks-list',authenticateJWT,  fmsTemplateController.getTemplateTasks);
router.get('/templates/export',authenticateJWT,  fmsTemplateController.exportTemplate);

// BRD 5.2 Template Tasks (Bulk + Single) - FIXED ROUTES
router.post('/templates/:id/tasks', authenticateJWT, upload.array('files'), fmsTaskController.createFmsTasks);
router.get('/fms-templates/:id/tasks',authenticateJWT,  fmsTaskController.getFmsTasksByTemplate);
router.put('/templates/:id/tasks/:taskId',authenticateJWT,  fmsTaskController.updateFmsTask);
router.post('/templates/:id/tasks/import',authenticateJWT, upload.single('file'), fmsTaskController.importFmsTasksUniversal);
router.delete('/templates/:id/tasks/:taskId', authenticateJWT, fmsTaskController.deleteFmsTask);

// BRD 002.2 Launch & Runtime
router.post('/instances/:templateId/launch', authenticateJWT, fmsInstanceController.launchFmsInstance);
router.post('/assigned-templates', authenticateJWT, fmsInstanceController.getAssignedTaskTemplates);
router.post('/instances', authenticateJWT, fmsInstanceController.getFmsInstances);
router.get('/instances-count', authenticateJWT, fmsInstanceController.getFmsInstancesCount);
router.get('/instances/:id',authenticateJWT,  fmsInstanceController.getFmsInstanceById);
router.get('/fmsInstanceTask/:id',  fmsInstanceController.getFMSInstanceTaskById);
router.get('/instances/:id/tasks',authenticateJWT,  fmsInstanceController.getInstanceTasks);
router.patch('/instances/:id/tasks/:taskId',authenticateJWT,  fmsInstanceController.updateFmsInstanceTask);
router.put('/instances/:id/tasks/:taskId/complete',authenticateJWT,  fmsInstanceController.completeInstanceTask);
router.patch(
  "/instances/:id/tasks/:taskId/formData",authenticateJWT,
  fmsInstanceController.updateFormData
);
router.patch("/instances/:id/tasks/:taskId/checklist"
, authenticateJWT, fmsInstanceController.updateChecklistItem);

router.put('/instances/:id/stop', authenticateJWT, fmsInstanceController.stopFmsInstance);
router.put('/instances/:id/hold', authenticateJWT, fmsInstanceController.holdFmsInstance);
router.put('/instances/:id/resume', authenticateJWT, fmsInstanceController.resumeFmsInstance);

export default router;

