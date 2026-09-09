import Role, { SYSTEM_MODULES } from "../models/Role.js"; // Model ka path check kar lein
import { handleAsync } from "../utils/handleAsync.js";
const getFullAccessPermissions = () =>
  SYSTEM_MODULES.flatMap((parent) =>
    parent.submodules.map((sub) => ({
      parentModuleKey: parent.key,
      submoduleKey: sub.key,
      actions: {
        create: true,
        read: true,
        update: true,
        delete: true,
      },
    }))
  );

// Fixed Roles Mapping for Standardization
const ROLE_NAME_MAPPINGS = {
  admin: { name: "admin", displayName: "Admin", isSystemRole: true, canDelete: false },
  "sr. manager": { name: "sr._manager", displayName: "Sr. Manager", isSystemRole: true, canDelete: false },
  "sr._manager": { name: "sr._manager", displayName: "Sr. Manager", isSystemRole: true, canDelete: false },
  manager: { name: "manager", displayName: "Manager", isSystemRole: true, canDelete: false },
  owner: { name: "owner", displayName: "Owner", isSystemRole: true, canDelete: false },
  member: { name: "member", displayName: "Member", isSystemRole: true, canDelete: false },
};

/**
 * 🟢 SAFE API CONTROLLER FOR ROLE MIGRATION
 * Endpoint: POST /api/v1/roles/migrate-permissions
 */
export const migrateRolePermissions = handleAsync(async (req, res, next) => {
  const fullPermissions = getFullAccessPermissions();

  // 1. Database se saare roles fetch karein
  const existingRoles = await Role.find({}).lean();
  
  if (!existingRoles.length) {
    // Agar DB khali ho toh default fixed roles initialize karein
    if (typeof Role.initializeFixedRoles === "function") {
      await Role.initializeFixedRoles();
    }
    return res.status(200).json({
      success: true,
      message: "No roles found. Initialized default fixed roles.",
    });
  }

  const bulkOperations = [];
  const processedNames = new Set();
  const duplicateIdsToDelete = [];

  // 2. Roles format karein aur duplicates trace karein
  for (const roleDoc of existingRoles) {
    const rawName = String(roleDoc.name || "").toLowerCase().trim();
    const mappedRole = ROLE_NAME_MAPPINGS[rawName];

    let targetName = mappedRole ? mappedRole.name : rawName.replace(/\s+/g, "_");
    let targetDisplayName = mappedRole ? mappedRole.displayName : (roleDoc.displayName || roleDoc.name);
    let targetIsSystem = mappedRole ? mappedRole.isSystemRole : Boolean(roleDoc.isSystemRole);
    let targetCanDelete = mappedRole ? mappedRole.canDelete : (roleDoc.canDelete !== undefined ? roleDoc.canDelete : true);

    // Agar same normalized name ka role pehle hi process ho chuka hai (Duplicate hai)
    if (processedNames.has(targetName)) {
      duplicateIdsToDelete.push(roleDoc._id);
      continue;
    }

    processedNames.add(targetName);

    // Atomic update operation prepare karein
    bulkOperations.push({
      updateOne: {
        filter: { _id: roleDoc._id },
        update: {
          $set: {
            name: targetName,
            displayName: targetDisplayName,
            isSystemRole: targetIsSystem,
            canDelete: targetCanDelete,
            permissions: fullPermissions, // Full Access Permissions
          },
        },
      },
    });
  }

  // 3. Duplicates remove karein (Agar DB me duplicate names ke multiple docs the)
  if (duplicateIdsToDelete.length > 0) {
    await Role.deleteMany({ _id: { $in: duplicateIdsToDelete } });
    console.log(`Deleted ${duplicateIdsToDelete.length} duplicate role documents.`);
  }

  // 4. Bulk Write Execute karein
  if (bulkOperations.length > 0) {
    await Role.bulkWrite(bulkOperations);
  }

  // 5. Ensure missing system fixed roles are initialized
  if (typeof Role.initializeFixedRoles === "function") {
    await Role.initializeFixedRoles();
  }

  // 6. Final safety check: Update full access to all system roles
  await Role.updateMany(
    { name: { $in: Object.values(ROLE_NAME_MAPPINGS).map((r) => r.name) } },
    { $set: { permissions: fullPermissions } }
  );

  return res.status(200).json({
    success: true,
    message: "Roles & Permissions migration executed successfully!",
    totalProcessed: bulkOperations.length,
    duplicatesRemoved: duplicateIdsToDelete.length,
  });
});