import mongoose from "mongoose";

// ----------------------------------------------------
// 1. SYSTEM MODULES & SUBMODULES TREE DEFINITION
// ----------------------------------------------------
export const SYSTEM_MODULES = [
  // 1. Dashboard
  {
    key: "dashboard",
    label: "Dashboard",
    submodules: [{ key: "dashboard", label: "Dashboard Main" }],
  },
  // 2. My Day
  {
    key: "my_day",
    label: "My Day",
    submodules: [
      { key: "delegated_recurring", label: "Delegated & Recurring" },
      { key: "fms_tasks", label: "FMS Tasks" },
      { key: "role_view", label: "Manager/Role View" },
    ],
  },
  // 3. Delegation Task
  {
    key: "delegation_task",
    label: "Delegation Task",
    submodules: [{ key: "delegation_task", label: "Delegation Task Main" }],
  },
  // 4. Task Reassignment
  {
    key: "task_reassigning",
    label: "Task Reassignment",
    submodules: [{ key: "task_reassigning", label: "Task Reassignment Main" }],
  },
  // 5. FMS Engine
  {
    key: "fms_engine",
    label: "FMS Engine",
    submodules: [
      { key: "fms_templates", label: "FMS Templates" },
      { key: "launch_fms", label: "Launch FMS" },
      { key: "upcoming_ongoing_fms", label: "Upcoming & Ongoing FMSs" },
      { key: "form_builder", label: "Form Builder" },
      { key: "responses", label: "Responses" },
    ],
  },
  // 6. Reports
  {
    key: "reports",
    label: "Reports",
    submodules: [
      { key: "mis_reports", label: "MIS Reports" },
      { key: "fms_reports", label: "FMS Reports" },
    ],
  },
  // 7. My Bucket
  {
    key: "my_bucket",
    label: "My Bucket",
    submodules: [{ key: "my_bucket", label: "My Bucket Main" }],
  },
  // 8. Delegation Buckets
  {
    key: "bucket",
    label: "Delegation Buckets",
    submodules: [
      { key: "task_buckets", label: "Task Buckets" },
      { key: "pending_buckets", label: "Pending Buckets Request" },
      { key: "bucket_view", label: "Buckets View" },
      { key: "manage_assignee", label: "Manage Assignee" },
    ],
  },
  // 9. Setup
  {
    key: "setup",
    label: "Setup",
    submodules: [
      { key: "roles_permissions", label: "Roles & Permissions" },
      { key: "departments_calendar", label: "Departments & Calendar" },
      { key: "work_shifts", label: "Work Shifts" },
      { key: "users", label: "Users" },
      { key: "company_setup", label: "Company Setup" },
    ],
  },
  // 10. Super Admin Module
  {
    key: "module_management",
    label: "Module Setting",
    submodules: [{ key: "module_setting", label: "Module Setting Main" }],
  },
];

// Flat Keys array for Enum validation
export const ALL_SUBMODULE_KEYS = SYSTEM_MODULES.flatMap((m) =>
  m.submodules.map((s) => s.key)
);

// ----------------------------------------------------
// 2. PERMISSION SUB-SCHEMAS
// ----------------------------------------------------
const actionPermissionSchema = new mongoose.Schema(
  {
    create: { type: Boolean, default: false },
    read: { type: Boolean, default: false },
    update: { type: Boolean, default: false },
    delete: { type: Boolean, default: false },
  },
  { _id: false }
);

const submodulePermissionSchema = new mongoose.Schema(
  {
    parentModuleKey: {
      type: String,
      required: [true, "Parent module key is required"],
      trim: true,
    },
    submoduleKey: {
      type: String,
      required: [true, "Submodule key is required"],
      enum: {
        values: ALL_SUBMODULE_KEYS,
        message: "{VALUE} is not a valid submodule key",
      },
    },
    actions: {
      type: actionPermissionSchema,
      default: () => ({
        create: false,
        read: false,
        update: false,
        delete: false,
      }),
    },
  },
  { _id: false }
);

// ----------------------------------------------------
// 3. MAIN ROLE SCHEMA
// ----------------------------------------------------
const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Role key name is required"],
      unique: true,
      trim: true,
      lowercase: true,
    },
    displayName: {
      type: String,
      required: [true, "Role display name is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    permissions: [submodulePermissionSchema],
    isSystemRole: {
      type: Boolean,
      default: false,
    },
    canDelete: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Unique Index
roleSchema.index({ name: 1 }, { unique: true });

// PRE-SAVE HOOK: Prevent duplicate submodule permissions in the same role while keeping all-false submodules intact
roleSchema.pre("save", function (next) {
  if (this.permissions && this.permissions.length > 0) {
    const submodulesList = this.permissions.map((p) => p.submoduleKey);
    const hasDuplicates =
      new Set(submodulesList).size !== submodulesList.length;

    if (hasDuplicates) {
      return next(
        new Error(
          "Duplicate submodule permissions are not allowed in the same role."
        )
      );
    }
  }
  next();
});

// Full access permissions payload generator helper
const getFullAccessPermissions = () =>
  SYSTEM_MODULES.flatMap((parent) =>
    parent.submodules.map((sub) => ({
      parentModuleKey: parent.key,
      submoduleKey: sub.key,
      actions: { create: true, read: true, update: true, delete: true },
    }))
  );

const FIXED_ROLES = [
  {
    name: "admin",
    displayName: "Admin",
    canDelete: false,
    isSystemRole: true,
    permissions: getFullAccessPermissions(),
  },
  {
    name: "owner",
    displayName: "Owner",
    canDelete: false,
    isSystemRole: true,
    permissions: getFullAccessPermissions(),
  },
  {
    name: "sr_manager",
    displayName: "Sr. Manager",
    canDelete: false,
    isSystemRole: true,
    permissions: [],
  },
  {
    name: "manager",
    displayName: "Manager",
    canDelete: false,
    isSystemRole: true,
    permissions: [],
  },
  {
    name: "member",
    displayName: "Member",
    canDelete: false,
    isSystemRole: true,
    permissions: [],
  },
];

// System Roles Initialization Method
roleSchema.statics.initializeFixedRoles = async function () {
  const operations = FIXED_ROLES.map((role) => ({
    updateOne: {
      filter: { name: role.name },
      update: { $setOnInsert: role },
      upsert: true,
    },
  }));

  await this.bulkWrite(operations);
};

const Role = mongoose.model("Role", roleSchema);
export default Role;