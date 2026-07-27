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
  filterFMSTasks,
  getFMSTaskStats,
  exportMYFMSTasks,
} from '../controllers/taskController.js';
import { reopenTask } from '../controllers/taskReopenController.js';

import upload from '../middleware/upload.js';
import { authenticateJWT } from '../middleware/authMiddleware.js';
import { generateRecurringTasks } from "../cron/assignRecurringTask.js";
import { DelegationTask } from "../models/Task.js";
import Task from '../models/Task.js';
import mongoose from "mongoose";
import moment from "moment";

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
router.post('/filter-fms', authenticateJWT, filterFMSTasks);

router.post('/myTask-stats', authenticateJWT, getTaskStats);
router.post('/myFmsTask-stats', authenticateJWT, getFMSTaskStats);

router.post('/my-task/export', authenticateJWT, exportMYTasks);
router.post('/my-task/export-fms', authenticateJWT, exportMYFMSTasks);

router.post('/role-based-tasks', authenticateJWT, getRoleBasedTasks);
router.post('/tasks-with-stats', authenticateJWT, getAllTasksWithStats);


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

router.post("/trigger-recurring", async (req, res) => {
  try {
    // const { recurringTaskId } = req.body;

    // Triggers the function and collects returned logs
    const result = await generateRecurringTasks();

    if (!result.success) {
      return res.status(500).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "API error executing recurring task trigger",
      error: error.message,
    });
  }
});
router.post("/cleanup-all-duplicates", async (req, res) => {
  const cleanupLogs = [];
  const addLog = (msg) => {
    console.log(msg);
    cleanupLogs.push(msg);
  };

  addLog("⚡ [PRODUCTION MODE] Starting Actual Soft-Delete for Duplicate Tasks...");

  try {
    // 1. Fetch all duplicate groups (all statuses included, missing isDeleted fields handled)
    const duplicateGroups = await DelegationTask.aggregate([
      {
        $match: {
          isDeleted: { $ne: true }, // handles both false and missing/undefined isDeleted fields
        },
      },
      {
        $group: {
          _id: {
            title: "$title",
            startDate: "$startDate",
            dueDate: "$dueDate",
            assignedTo: "$assignedTo",
          },
          count: { $sum: 1 },
          taskIds: { $push: "$_id" },
          displayIds: { $push: "$TaskId" },
          statuses: { $push: "$status" },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
    ]);

    addLog(`\n🔍 Total Duplicate Group(s) Found: ${duplicateGroups.length}`);

    if (duplicateGroups.length === 0) {
      addLog("✨ No duplicate tasks found to clean up!");
      return res.status(200).json({
        success: true,
        message: "No duplicates found.",
        stats: { totalGroupsFound: 0, totalDeleted: 0 },
        logs: cleanupLogs,
      });
    }

    let totalDeletedCount = 0;

    for (const [index, group] of duplicateGroups.entries()) {
      const { title, startDate, dueDate } = group._id;
      const ids = group.taskIds;
      const displayIds = group.displayIds;
      const statuses = group.statuses;

      // First Occurrence is KEPT SAFE
      const keepTaskId = ids[0];
      const keepDisplayId = displayIds[0] || keepTaskId;
      const keepStatus = statuses[0];

      // Redundant occurrences get soft-deleted
      const deleteIds = ids.slice(1);
      const deleteDisplayIds = displayIds.map((id, i) => id || ids[i]).slice(1);
      const deleteStatuses = statuses.slice(1);

      addLog(`\n--------------------------------------------------`);
      addLog(`📌 Group #${index + 1}: "${title}"`);
      addLog(`📅 Start Date: ${moment(startDate).format("YYYY-MM-DD HH:mm:ss")}`);
      addLog(`📅 Due Date:   ${moment(dueDate).format("YYYY-MM-DD HH:mm:ss")}`);
      addLog(`📊 Total Tasks in this Group: ${group.count}`);
      addLog(`🛡️ [KEPT SAFE]: Task ID: ${keepDisplayId} | Status: "${keepStatus}"`);

      deleteDisplayIds.forEach((id, idx) => {
        addLog(`🗑️ [SOFT-DELETED]: Task ID: ${id} | Status: "${deleteStatuses[idx]}"`);
      });

      // 2. ACTUAL DATABASE UPDATE
      await DelegationTask.updateMany(
        { _id: { $in: deleteIds } },
        { $set: { isDeleted: true } }
      );

      totalDeletedCount += deleteIds.length;
    }

    addLog(`\n--------------------------------------------------`);
    addLog(`🎉 [CLEANUP COMPLETE] SUMMARY:`);
    addLog(` Total Duplicate Groups Processed: ${duplicateGroups.length}`);
    addLog(` Total Duplicate Tasks Marked isDeleted: true : ${totalDeletedCount}`);

    return res.status(200).json({
      success: true,
      message: "Successfully soft-deleted all duplicate tasks.",
      stats: {
        totalGroupsFound: duplicateGroups.length,
        totalDeleted: totalDeletedCount,
      },
      logs: cleanupLogs,
    });
  } catch (error) {
    const errorMsg = `❌ Cleanup Failed: ${error.message}`;
    addLog(errorMsg);

    return res.status(500).json({
      success: false,
      message: "Error updating duplicate records.",
      error: error.message,
      logs: cleanupLogs,
    });
  }
});

router.post("/migrate-existing-tasks", async (req, res) => {
  const migrationLogs = [];
  const addLog = (msg) => {
    console.log(msg);
    migrationLogs.push(msg);
  };

  addLog("⚡ [PRODUCTION MODE] Starting Migration: Adding 'isDeleted: false' and 'instanceKey'...");

  try {
    // 1. Fetch records missing EITHER `isDeleted` OR `instanceKey`
    // Soft-deleted records (isDeleted: true) ko filter out kar diya hai
    const tasksToMigrate = await DelegationTask.find({
      isDeleted: { $ne: true }, // Skip already soft-deleted tasks
      $or: [
        { isDeleted: { $exists: false } },
        { instanceKey: { $exists: false } },
        { instanceKey: null },
        { instanceKey: "" },
      ],
    });

    addLog(`🔍 Found ${tasksToMigrate.length} active record(s) needing update.`);

    if (tasksToMigrate.length === 0) {
      addLog("✨ All active records already have 'isDeleted' and 'instanceKey' set!");
      return res.status(200).json({
        success: true,
        message: "No records needed migration.",
        stats: { totalFound: 0, updatedCount: 0, skippedCount: 0 },
        logs: migrationLogs,
      });
    }

    let updatedCount = 0;
    let skippedCount = 0;

    for (const [index, task] of tasksToMigrate.entries()) {
      // Extra safety check: agar dono fields pehle se properly populated hain toh skip karein
      if (task.isDeleted === false && task.instanceKey) {
        addLog(`⏭️ Skip #${index + 1}: Task ID ${task.TaskId || task._id} already up to date.`);
        skippedCount++;
        continue;
      }

      // 2. Generate instanceKey (recurrenceTaskId ya _id + Start Date YYYY-MM-DD)
      const dateSource = task.startDate || task.createdAt || new Date();
      const dateStr = moment(dateSource).format("YYYY-MM-DD");

      const generatedInstanceKey = task.recurrenceTaskId
        ? `${task.recurrenceTaskId}_${dateStr}`
        : `${task._id}_${dateStr}`;

      // Build update payload dynamically
      const updateData = {};

      if (task.isDeleted === undefined || task.isDeleted === null) {
        updateData.isDeleted = false;
      }

      if (!task.instanceKey) {
        updateData.instanceKey = generatedInstanceKey;
      }

      // 3. Database me update karein
      await DelegationTask.updateOne(
        { _id: task._id },
        { $set: updateData }
      );

      updatedCount++;
      addLog(
        `✅ Updated #${index + 1}: Task ID ${task.TaskId || task._id} | ` +
        `isDeleted: false | instanceKey: "${updateData.instanceKey || task.instanceKey}"`
      );
    }

    addLog(`\n--------------------------------------------------`);
    addLog(`🎉 [MIGRATION COMPLETE] SUMMARY:`);
    addLog(` Total Tasks Scanned: ${tasksToMigrate.length}`);
    addLog(` Total Updated Records: ${updatedCount}`);
    addLog(` Total Skipped Records: ${skippedCount}`);

    return res.status(200).json({
      success: true,
      message: "Migration completed successfully.",
      stats: {
        totalFound: tasksToMigrate.length,
        updatedCount,
        skippedCount,
      },
      logs: migrationLogs,
    });
  } catch (error) {
    const errorMsg = `❌ Migration Failed: ${error.message}`;
    addLog(errorMsg);

    return res.status(500).json({
      success: false,
      message: "Error migrating tasks.",
      error: error.message,
      logs: migrationLogs,
    });
  }
});

router.post('/fix-delegation-dates', async (req, res) => {
  try {
    // 1. Fetch non-deleted Delegation Tasks that have an instanceKey
    const tasks = await Task.find({
      taskType: "DelegationTask",
      isDeleted: false,
      instanceKey: { $exists: true, $ne: null }
    });

    console.log(`\n================ UPDATE PROCESS STARTED ================`);
    console.log(`[LOG] Total Delegation Tasks fetched: ${tasks.length}`);

    const tasksToUpdate = [];

    // 2. Filter tasks where instanceKey date doesn't match current startDate
    for (const task of tasks) {
      // Extract YYYY-MM-DD from instanceKey (e.g., "6a5778e69aeb5349fbd41b38_2026-07-23" -> "2026-07-23")
      const instanceDateStr = task.instanceKey.split('_')[1];

      if (!instanceDateStr) continue;

      // Current startDate string (YYYY-MM-DD)
      const currentStartDateStr = new Date(task.startDate).toISOString().split('T')[0];

      // Check for mismatch
      if (instanceDateStr !== currentStartDateStr) {
        // Construct new start date (preserving original time offset or setting start of day)
        const newStartDate = new Date(`${instanceDateStr}T04:30:00.000Z`);

        tasksToUpdate.push({
          taskId: task._id,
          TaskIdCode: task.TaskId,
          oldStartDate: currentStartDateStr,
          newStartDate: instanceDateStr,
          newStartDateObj: newStartDate
        });
      }
    }

    console.log(`[LOG] Found ${tasksToUpdate.length} tasks needing update.`);

    if (tasksToUpdate.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No tasks required updates. All dates are already in sync!",
        updatedCount: 0
      });
    }

    // 3. Perform bulk update in Database
    const bulkOps = tasksToUpdate.map(item => ({
      updateOne: {
        filter: { _id: item.taskId },
        update: { $set: { startDate: item.newStartDateObj } }
      }
    }));

    const updateResult = await Task.bulkWrite(bulkOps);

    console.log(`[SUCCESS] Database updated successfully!`);
    console.log(`  └ Modified Count: ${updateResult.modifiedCount}`);
    console.log(`================ UPDATE PROCESS COMPLETED ==============\n`);

    // 4. Send Response
    return res.status(200).json({
      success: true,
      message: `Successfully updated ${updateResult.modifiedCount} tasks.`,
      updatedCount: updateResult.modifiedCount,
      updatedTaskDetails: tasksToUpdate
    });

  } catch (error) {
    console.error("[ERROR] Failed to update tasks:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;