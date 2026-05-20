import express from 'express';
import {
  createTask,
  getAllTasks, 
  getTaskById,
  updateTask,
  deleteTask,
  deleteParentAndChildren,
  toggleTaskCompletion,
  downloadAttachment,
  exportTasks,
  importTasks,
  uploadAttachment,
  getAllTasksWithStats,
  filterTasks,
  getRoleBasedTasks,
  getTaskStats,
  updateChecklistItem,
  getConversations,
  exportMYTasks,
} from '../controllers/taskController.js';
import { reopenTask } from '../controllers/taskReopenController.js';

import upload from '../middleware/upload.js';
import { authenticateJWT } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/', authenticateJWT, upload.array('attachmentFile'), createTask);

// Import Tasks from CSV
router.post('/import', authenticateJWT, upload.single('file'), importTasks);

// Upload attachment
router.post(
  '/upload-attachment',
  authenticateJWT,
  upload.array('attachments', 100),
  uploadAttachment
);


router.get('/', authenticateJWT, getAllTasks);
router.post('/filter', authenticateJWT, filterTasks);
router.post('/myTask-stats', authenticateJWT, getTaskStats);
router.post('/role-based-tasks', authenticateJWT, getRoleBasedTasks);
router.post('/tasks-with-stats', authenticateJWT, getAllTasksWithStats);
router.post('/my-task/export', authenticateJWT, exportMYTasks);

router.post('/export', authenticateJWT, exportTasks);

router.get('/download', downloadAttachment);

router.get('/:id', getTaskById);

router.get('/:id/conversation', getConversations);

router.put('/:id', authenticateJWT, upload.array('attachmentFile'), updateTask);

router.patch('/:id/completion', authenticateJWT, toggleTaskCompletion);

router.patch('/:id/reopen', authenticateJWT, reopenTask);

router.patch('/:id/checklist/:index', authenticateJWT, updateChecklistItem);

router.delete('/:id', authenticateJWT, deleteTask);

router.delete('/:id/force', authenticateJWT, deleteParentAndChildren);

export default router;