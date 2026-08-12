import mongoose from "mongoose";
import dotenv from "dotenv";

import Role from "../src/models/Role.js";
import User from "../src/models/User.js";

import ModuleSetting from "../src/models/ModuleSetting.js";
import WorkShift from "../src/models/WorkShift.js";
import Department from "../src/models/Department.js";
import WorkingWeek from "../src/models/WorkingWeek.js";

dotenv.config();

// function must(name) {
//   const v = process.env[name];
//   if (!v) throw new Error(`Missing env var: ${name}`);
//   return v;
// }
async function ensureDefaultModules() {
  const modules = ["DO_THIS2", "FMS_ENGINE", "COMPANY_SETUP"];

  for (const moduleKey of modules) {
    await ModuleSetting.findOneAndUpdate(
      { moduleKey },
      {
        $setOnInsert: {
          moduleKey,
          isEnabled: true,
          updatedBy: null,
        },
      },
      {
        upsert: true,
      },
    );
  }

  console.log("Default module settings ensured.");
}

async function ensureDefaultWorkingWeek() {
  // Fixed: Find the single working week configuration matching the new schema
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
    // Fixed: Initialise workingWeekDays property matching the updated Department schema
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
  const existing = await User.findOne({
    $or: [{ email: email.toLowerCase() }, { employeeCode }],
    isDeleted: false,
  });

  if (existing) {
    console.log(
      `User already exists (${existing.email} | ${existing.employeeCode}). Skipping.`,
    );
    return existing;
  }

  const user = await User.create({
    name,
    email: email.toLowerCase(),
    phone,
    employeeCode,
    companyCode: "",
    department: departmentIds,
    role: roleId,
    reportingManager: null,
    assignShift,
    password,
    isActive: true,
    isEmailNotificationEnabled: false,
    mainEmailType: "email",
    secondaryEmail: "",
    refreshToken: null,
  });

  console.log(`${name} created.`);
  return user;
}

async function main() {
  const MONGODB_URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "mongodb://localhost:27017/dothis2";

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGODB_URI);
  }

  // Ensure fixed roles exist (your Role model has initializeFixedRoles)
  if (typeof Role.initializeFixedRoles === "function") {
    await Role.initializeFixedRoles();
  }

  await ensureDefaultModules();

  const allPermissions = [
    "Setup",
    "Reports",
    "Delegation Task",
    "FmsEngine",
    "Module Management",
    "Company Setup",
    "Task Reassigning",
    "My Bucket",
    "Bucket",
  ];
  const mgSmgPermissions = [
    "Setup",
    "Reports",
    "Delegation Task",
    "FmsEngine",
    "Module Management",
    "Company Setup",
    "Task Reassigning",
    "My Bucket",
    // "Bucket",
  ];
  const superRole = await ensureRole({
    name: "Super",
    permissions: allPermissions,
  });

  const adminRole = await ensureRole({
    name: "Admin",
    permissions: allPermissions,
  });

  const srManagerRole = await ensureRole({
    name: "Sr. Manager",
    permissions: mgSmgPermissions,
  });
  const managerRole = await ensureRole({
    name: "Manager",
    permissions: mgSmgPermissions,
  });

  const defaultShift = await ensureDefaultShift();
  const openDepartment = await ensureOpenDepartment();
  await ensureDefaultWorkingWeek();
  let assignShift = defaultShift._id.toString();
  const departmentIds = [openDepartment._id];

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

  const defaultModules = ["DO_THIS2", "FMS_ENGINE", "COMPANY_SETUP"];

  for (const moduleKey of defaultModules) {
    await ModuleSetting.findOneAndUpdate(
      { moduleKey },
      { $setOnInsert: { moduleKey, isEnabled: true, updatedBy: null } },
      { upsert: true, new: true },
    );
  }

  console.log("Seed complete.");
}

main();
