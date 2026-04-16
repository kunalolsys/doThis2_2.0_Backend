import express from 'express';
import {
  raiseQuery,
  replyToQuery,
  getTaskQueries,
} from '../controllers/queries/queryController.js';
import { authenticateJWT } from '../middleware/auth.js';

const router = express.Router();

router.post('/raise',  raiseQuery);
router.post('/reply',  replyToQuery);
router.get('/task/:taskId', getTaskQueries);

export default router;

