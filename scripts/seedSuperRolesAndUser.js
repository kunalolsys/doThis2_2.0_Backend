import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";

import Role, { SYSTEM_MODULES } from "../src/models/Role.js";
import User from "../src/models/User.js";

import ModuleSetting from "../src/models/ModuleSetting.js";
import WorkShift from "../src/models/WorkShift.js";
import Department from "../src/models/Department.js";
import WorkingWeek from "../src/models/WorkingWeek.js";

dotenv.config();

// Helper: Generates full CRUD access mapped across all submodules in SYSTEM_MODULES
const getFullAccessPermissions = (modulesTree) =>
  modulesTree.flatMap((parent) =>
    parent.submodules.map((sub) => ({
      parentModuleKey: parent.key,
      submoduleKey: sub.key,
      actions: { create: true, read: true, update: true, delete: true },
    }))
  );

// Helper: Generates manager-level access excluding specific restricted submodules
const getManagerAccessPermissions = (modulesTree) =>
  modulesTree.flatMap((parent) =>
    parent.submodules
      .filter(
        (sub) =>
          !["task_buckets", "pending_buckets", "bucket_view"].includes(sub.key)
      )
      .map((sub) => ({
        parentModuleKey: parent.key,
        submoduleKey: sub.key,
        actions: { create: true, read: true, update: true, delete: true },
      }))
  );

async function ensureDefaultModules() {
  const modules = ["DO_THIS2", "FMS_ENGINE", "COMPANY_SETUP"];

  const operations = modules.map((moduleKey) => ({
    updateOne: {
      filter: { moduleKey },
      update: {
        $setOnInsert: {
          moduleKey,
          isEnabled: true,
          updatedBy: null,
        },
      },
      upsert: true,
    },
  }));

  await ModuleSetting.bulkWrite(operations);
  console.log("Default module settings ensured.");
}

async function ensureDefaultWorkingWeek() {
  let workingWeek = await WorkingWeek.findOne();

  if (!workingWeek) {
    workingWeek = await WorkingWeek.create({
      workingDays: {
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: false,
      },
    });
    console.log("Default working week created.");
  }

  return workingWeek;
}

async function ensureOpenDepartment() {
  let department = await Department.findOne({
    name: "Open Department",
    isDeleted: false,
  });

  if (!department) {
    department = await Department.create({
      name: "Open Department",
      workingWeekDays: {
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: false,
      },
    });
    console.log("Open Department created.");
  }

  return department;
}

// FIXED: Clear out legacy format permissions and set new schema payload directly
async function ensureRole({ name, displayName, permissions }) {
  const formattedName = name.trim().toLowerCase().replace(/\s+/g, "_");

  let role = await Role.findOne({ name: formattedName });

  if (!role) {
    return await Role.create({
      name: formattedName,
      displayName: displayName || name,
      permissions,
      isSystemRole: true,
      canDelete: false,
    });
  }

  // Set fresh permissions matching new Submodule schema to override old legacy schema
  role.permissions = permissions;
  role.canDelete = false;
  role.isSystemRole = true;

  await role.save();
  return role;
}

async function ensureDefaultShift() {
  let shift = await WorkShift.findOne({
    name: "General Shift",
    isDeleted: false,
  });

  if (!shift) {
    shift = await WorkShift.create({
      name: "General Shift",
      startTime: "09:00",
      endTime: "18:00",
      workingDays: {
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: true,
      },
    });

    console.log("Default shift created.");
  }

  return shift;
}

async function ensureUser({
  employeeCode,
  name,
  email,
  phone,
  password,
  roleId,
  assignShift,
  departmentIds,
}) {
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await User.findOne({
    $or: [{ email: normalizedEmail }, { employeeCode }],
    isDeleted: false,
  });

  if (existing) {
    console.log(
      `User already exists (${existing.email} | ${existing.employeeCode}). Skipping.`
    );
    return existing;
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const user = await User.create({
    name,
    email: normalizedEmail,
    phone,
    employeeCode,
    companyCode: "",
    department: departmentIds,
    role: roleId,
    reportingManager: null,
    assignShift,
    password: hashedPassword,
    isActive: true,
    isEmailNotificationEnabled: false,
    mainEmailType: "email",
    secondaryEmail: "",
    refreshToken: null,
  });

  console.log(`User created: ${name}`);
  return user;
}

async function main() {
  try {
    const MONGODB_URI =
      process.env.MONGODB_URI ||
      process.env.MONGO_URI ||
      "mongodb://localhost:27017/dothis2";

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGODB_URI);
      console.log("MongoDB connected for seeding.");
    }

    // 1. Initialize System Module Settings
    await ensureDefaultModules();

    // 2. Prepare Permissions Array matching new Nested Submodule Schema
    const fullPermissions = getFullAccessPermissions(SYSTEM_MODULES);
    const managerPermissions = getManagerAccessPermissions(SYSTEM_MODULES);

    // 3. Ensure Fixed System Roles
    const superRole = await ensureRole({
      name: "Super",
      displayName: "Super",
      permissions: fullPermissions,
    });

    const adminRole = await ensureRole({
      name: "Admin",
      displayName: "Admin",
      permissions: fullPermissions,
    });

    const srManagerRole = await ensureRole({
      name: "Sr. Manager",
      displayName: "Sr. Manager",
      permissions: managerPermissions,
    });

    const managerRole = await ensureRole({
      name: "Manager",
      displayName: "Manager",
      permissions: managerPermissions,
    });

    // 4. Ensure Organizational Defaults
    const defaultShift = await ensureDefaultShift();
    const openDepartment = await ensureOpenDepartment();
    await ensureDefaultWorkingWeek();

    const assignShift = defaultShift._id.toString();
    const departmentIds = [openDepartment._id];

    // 5. Seed Core System Users
    await ensureUser({
      employeeCode: "SUPER001",
      name: "Super User",
      email: process.env.SUPERUSER_EMAIL || "super@gmail.com",
      phone: "1234567890",
      password: process.env.SUPERUSER_PASSWORD || "Super@123",
      roleId: superRole._id,
      assignShift,
      departmentIds,
    });

    await ensureUser({
      employeeCode: "ADMIN001",
      name: "Admin",
      email: "admin@dothis2.com",
      phone: "1234567810",
      password: "Admin@123",
      roleId: adminRole._id,
      assignShift,
      departmentIds,
    });

    await ensureUser({
      employeeCode: "SRMANAGER001",
      name: "Sr Manager",
      email: "srmanager@dothis2.com",
      phone: "1224567890",
      password: "SrManager@123",
      roleId: srManagerRole._id,
      assignShift,
      departmentIds,
    });

    await ensureUser({
      employeeCode: "MANAGER001",
      name: "Manager",
      email: "manager@dothis2.com",
      phone: "1234562290",
      password: "Manager@123",
      roleId: managerRole._id,
      assignShift,
      departmentIds,
    });

    console.log("Seeding process completed successfully.");
    // process.exit(0);
  } catch (error) {
    console.error("Seeding failed:", error);
    // process.exit(1);
  }
}

main();