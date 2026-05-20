import mongoose from "mongoose";
import dotenv from "dotenv";

import Role from "../src/models/Role.js";
import User from "../src/models/User.js";

import ModuleSetting from "../src/models/ModuleSetting.js";
import WorkShift from "../src/models/WorkShift.js";

dotenv.config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function ensureRole({ name, permissions }) {
  const role = await Role.findOne({ name });
  if (!role) {
    return await Role.create({ name, permissions, canDelete: false });
  }

  // update permissions if needed
  const set = new Set(role.permissions || []);
  for (const p of permissions) set.add(p);
  role.permissions = Array.from(set);

  // fixed roles should not be deleted
  role.canDelete = false;

  await role.save();
  return role;
}

async function main() {
  const MONGODB_URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "mongodb://localhost:27017/dothis2";

  await mongoose.connect(MONGODB_URI);

  // Ensure fixed roles exist (your Role model has initializeFixedRoles)
  if (typeof Role.initializeFixedRoles === "function") {
    await Role.initializeFixedRoles();
  }

  // 1) Create SUPER role (single role that contains all permissions)
  const allPermissions = [
    "Setup",
    "Reports",
    "Delegation Task",
    "FmsEngine",
    "Module Management",
    "Task Reassigning",
  ];

  const superRole = await ensureRole({
    name: "Super",
    permissions: allPermissions,
  });

  // 2) Create/update super user
  const SUPERUSER_EMAIL = must("SUPERUSER_EMAIL").toLowerCase().trim();
  const SUPERUSER_PASSWORD = must("SUPERUSER_PASSWORD");

  const SUPERUSER_PHONE = process.env.SUPERUSER_PHONE || "9999999999";
  const SUPERUSER_NAME = process.env.SUPERUSER_NAME || "Super User";

  // Your User schema requires assignShift (WorkShift id).
  // For simplicity, pick the first WorkShift record if env is not provided.
  let assignShift = process.env.SUPERUSER_ASSIGNSHIFT_ID;

  if (!assignShift) {
    const firstShift = await WorkShift.findOne({});
    if (!firstShift)
      throw new Error(
        "No WorkShift records found in DB to set SUPER user assignShift",
      );
    assignShift = firstShift._id.toString();
  }

  const existing = await User.findOne({
    email: SUPERUSER_EMAIL,
    isDeleted: false,
  });

  if (!existing) {
    await User.create({
      srNo: 0,
      name: SUPERUSER_NAME,
      email: SUPERUSER_EMAIL,
      phone: SUPERUSER_PHONE,
      employeeCode: "",
      companyCode: "",
      department: [],
      role: superRole._id,
      reportingManager: null,
      assignShift,
      password: SUPERUSER_PASSWORD,
      isActive: true,
      isEmailNotificationEnabled: false,
      mainEmailType: "email",
      secondaryEmail: "",
      refreshToken: null,
    });
    console.log("Super user created.");
  } else {
    let changed = false;
    if (existing.role?.toString() !== superRole._id.toString()) {
      existing.role = superRole._id;
      changed = true;
    }

    // update password always (schema will hash on save)
    existing.password = SUPERUSER_PASSWORD;
    existing.isActive = true;
    existing.phone = SUPERUSER_PHONE;
    existing.name = SUPERUSER_NAME;
    existing.assignShift = assignShift;

    if (changed) {
      await existing.save();
    } else {
      // still save to apply password hash
      await existing.save();
    }

    console.log("Super user ensured (updated).");
  }

  // 3) Ensure ModuleSetting rows exist for known module keys
  const defaultModules = ["DO_THIS2", "FMS_ENGINE", "COMPANY_SETUP"];

  for (const moduleKey of defaultModules) {
    await ModuleSetting.findOneAndUpdate(
      { moduleKey },
      { $setOnInsert: { moduleKey, isEnabled: true, updatedBy: null } },
      { upsert: true, new: true },
    );
  }

  // await mongoose.disconnect();
  console.log("Seed complete.");
}

main();
