import ModuleSetting from "../models/ModuleSetting.js";

// Map route prefixes to moduleKey(s)
const routeToModuleKey = (path) => {
  if (!path) return [];

  // if (path.startsWith("/api/v1/setup")) {
  //   return ["SETUP"];
  // }

  // if (path.startsWith("/api/v1/fms-report") || path.startsWith("/api/v1/mis")) {
  //   return ["REPORTS"];
  // }

  if (path.startsWith("/api/v1/fms")) {
    return ["FMS_ENGINE"];
  }

  // // Shared APIs
  // if (path.startsWith("/api/v1/tasks") || path.startsWith("/api/v1/queries")) {
  //   return ["DO_THIS2"];
  // }

  return [];
};

// SUPER user bypass
const isSuperByPermission = (req) => {
  try {
    const permissions = JSON.parse(req.cookies?.permissions || "{}");

    return permissions.module_management_view === true;
  } catch (err) {
    return false;
  }
};

let cache = { at: 0, data: new Map() };
const CACHE_TTL_MS = 15000;

async function loadModules() {
  const now = Date.now();

  if (!cache.at || now - cache.at > CACHE_TTL_MS) {
    const all = await ModuleSetting.find({ deletedAt: null });

    cache.data = new Map(all.map((d) => [d.moduleKey, d.isEnabled]));

    cache.at = now;
  }

  return cache.data;
}

export const moduleGate = async (req, res, next) => {
  try {
    // ✅ Super bypass
    if (isSuperByPermission(req)) {
      return next();
    }

    const moduleKeys = routeToModuleKey(req.originalUrl || req.url);

    // no module mapping
    if (!moduleKeys.length) {
      return next();
    }

    const modules = await loadModules();

    // ✅ allow if ANY mapped module enabled
    const hasEnabledModule = moduleKeys.some((key) => {
      // default enabled if missing
      if (!modules.has(key)) return true;

      return modules.get(key) === true;
    });

    if (!hasEnabledModule) {
      return res.status(403).json({
        success: false,
        message: `Module disabled`,
      });
    }

    return next();
  } catch (err) {
    return next(err);
  }
};
