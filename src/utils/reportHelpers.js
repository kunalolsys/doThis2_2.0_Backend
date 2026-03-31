import User from "../models/User.js";
import mongoose from "mongoose";

export const getSubordinates = async (userId, levels = 'all') => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return [];
  
  const subordinates = [];
  const queue = [userId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const directReports = await User.find({ 
      reportingManager: currentId, 
      isDeleted: false,
      isActive: true 
    }).select('_id').lean();

    for (const report of directReports) {
      subordinates.push(report._id);
      if (levels === 'all' || levels > 0) {
        queue.push(report._id);
      }
    }
  }
  
  return subordinates;
};

export const getDateRange = (period, customStart, customEnd) => {
  const now = new Date();
  now.setHours(0, 0, 0, 0); // Start of day

  let start, end;

  if (customStart && customEnd) {
    start = new Date(customStart);
    end = new Date(customEnd);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  switch (period) {
    case 'weekly':
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      end = now;
      break;
    case 'quarterly':
      const quarter = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), quarter * 3, 1);
      end = new Date(now.getFullYear(), (quarter + 1) * 3, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case 'yearly':
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now.getFullYear(), 11, 31);
      end.setHours(23, 59, 59, 999);
      break;
    default:
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // default monthly
      end = now;
  }

  return { start, end };
};
