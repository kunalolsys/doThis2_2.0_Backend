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
} from '../controllers/taskController.js'; // Ensure this matches your actual controller filename
import upload from '../middleware/upload.js';
import { authenticateJWT } from '../middleware/auth.js';

const router = express.Router();

// Create Task (Handles both Delegation and Recurring based on payload)
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

// Get All Tasks
// Supports filters via query params: ?userId=xxx, ?status=xxx, ?search=xxx
// Note: This replaces the specific '/user/:userId' route.
router.get('/', authenticateJWT, getAllTasks);
router.post('/filter', authenticateJWT, filterTasks);
router.post('/myTask-stats', authenticateJWT, getTaskStats);
router.post('/role-based-tasks', authenticateJWT, getRoleBasedTasks);
router.post('/tasks-with-stats', authenticateJWT, getAllTasksWithStats);

// Export Tasks
router.post('/export', authenticateJWT, exportTasks);

// Download attachment
router.get('/download', downloadAttachment);

// Get Single Task by ID
router.get('/:id', authenticateJWT, getTaskById);

// 🔌 Task Conversation & Messages
router.get('/:id/conversation', authenticateJWT, getConversations);

// Update Task (General updates, Status, File, Description)
router.put('/:id', authenticateJWT, upload.array('attachmentFile'), updateTask);

// Toggle Task Completion (Mark as Complete/Incomplete)
router.patch('/:id/completion', authenticateJWT, toggleTaskCompletion);
// Toggle single checklist item
router.patch('/:id/checklist/:index', authenticateJWT, updateChecklistItem);

// Delete Task (hard delete single)
router.delete('/:id', authenticateJWT, deleteTask);

// Force delete parent and all dependent child tasks with remark (confirmation required from frontend)
router.delete('/:id/force', authenticateJWT, deleteParentAndChildren);

export default router;