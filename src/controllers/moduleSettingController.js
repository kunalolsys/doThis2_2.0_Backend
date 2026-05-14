import ModuleSetting from "../models/ModuleSetting.js";
import { handleAsync } from "../utils/handleAsync.js";
import AppError from "../utils/AppError.js";
import { createLog } from "./logController.js";

const upsertModuleSetting = handleAsync(async (req, res, next) => {
  const { moduleKey, isEnabled } = req.body;

  if (!moduleKey) return next(new AppError("moduleKey is required", 400));
  if (typeof isEnabled !== "boolean") {
    return next(new AppError("isEnabled must be boolean", 400));
  }

  const updated = await ModuleSetting.findOneAndUpdate(
    { moduleKey },
    { $set: { moduleKey, isEnabled } },
    { new: true, upsert: true },
  );

  await createLog({
    action: "UPDATE_MODULE_SETTING",
    module: "SETUP",
    documentId: updated._id,
    performedBy: req.cookies.userId || req.user?._id || null,
    newData: updated,
    message: `Module ${moduleKey} set to ${isEnabled}`,
  });

  res.status(200).json({ success: true, data: updated });
});

const listModules = handleAsync(async (req, res) => {
  const modules = await ModuleSetting.find({ deletedAt: null });
  res.status(200).json({ success: true, data: modules });
});

export { upsertModuleSetting, listModules };
