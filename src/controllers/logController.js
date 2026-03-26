import Department from "../models/Department.js";
import { Log } from "../models/log.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import WorkShift from "../models/WorkShift.js";
import Role from "../models/Role.js";
const REF_FIELDS = {
  department: {
    model: Department,
    select: "name",
    label: "name",
    isArray: true, // 🔥 important
  },
  reportingManager: {
    model: User,
    select: "name",
    label: "name",
    isArray: false,
  },
  assignedTo: {
    model: User,
    select: "name",
    label: "name",
    isArray: false,
  },
  role: {
    model: Role,
    select: "name",
    label: "name",
    isArray: false,
  },
  assignedBy: {
    model: User,
    select: "name",
    label: "name",
    isArray: false,
  },
  assignShift: {
    model: WorkShift,
    select: "name",
    label: "name",
    isArray: false,
  },
};
export const enrichReferenceFields = async (data) => {
  if (!data) return null;

  const result = { ...data };

  // ✅ HANDLE CHECKLIST (NO POPULATE)
  if (Array.isArray(data.checklist)) {
    result.checklist = data.checklist
      .map((item) => item.text)
      .filter(Boolean) // remove empty/null
      .join(", "); // 🔥 convert to clean string
  }

  // 🔥 HANDLE REFERENCES
  for (const key in REF_FIELDS) {
    const config = REF_FIELDS[key];

    if (!data[key]) continue;

    if (config.isArray && Array.isArray(data[key])) {
      const docs = await config.model
        .find({ _id: { $in: data[key] } })
        .select(config.select);

      result[key] = data[key].map((id) => {
        const found = docs.find((d) => d._id.toString() === id.toString());

        return {
          id,
          name: found?.[config.label] || "Unknown",
        };
      });
    } else {
      const doc = await config.model.findById(data[key]).select(config.select);

      result[key] = {
        id: data[key],
        name: doc?.[config.label] || "Unknown",
      };
    }
  }

  return result;
};
export const createLog = async ({
  action,
  module,
  documentId,
  performedBy,
  oldData = null,
  newData = null,
  message = "",
}) => {
  try {
    const clean = (data) => {
      if (!data) return null;
      return data.toObject ? data.toObject() : data;
    };

    const enrichedOld = await enrichReferenceFields(clean(oldData));
    const enrichedNew = await enrichReferenceFields(clean(newData));

    await Log.create({
      action,
      module,
      documentId,
      performedBy,
      oldData: enrichedOld,
      newData: enrichedNew,
      message,
    });
  } catch (err) {
    console.error("Logging failed:", err.message);
  }
};
export const getLogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, performedBy, module, action } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let filter = {};

    const userRole = req.cookies?.role;
    const userId = req.cookies?.userId;

    // 🔐 ROLE BASED ACCESS
    if (userRole !== "Admin") {
      // normal user → only their logs
      if (mongoose.Types.ObjectId.isValid(userId)) {
        filter.performedBy = userId;
      }
    } else {
      // admin → can filter any user
      if (performedBy && mongoose.Types.ObjectId.isValid(performedBy)) {
        filter.performedBy = performedBy;
      }
    }

    // 🎯 OTHER FILTERS
    if (module) filter.module = module;
    if (action) filter.action = action;

    const logs = await Log.find(filter)
      .select(
        "-__v -oldData.password -newData.password -oldData.__v -newData.__v -newData.updatedAt -oldData.updatedAt -newData.attachmentFile -oldData.attachmentFile",
      )
      .populate("performedBy", "name email") // ✅ FIXED
      // .populate("checklist", "text") // ✅ FIXED
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Log.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: logs,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
};
