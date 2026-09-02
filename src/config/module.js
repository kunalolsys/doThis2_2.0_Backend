export const SYSTEM_MODULES = [
  {
    key: "dashboard",
    label: "Dashboard",
    submodules: [{ key: "dashboard", label: "Dashboard Main" }],
  },
  {
    key: "my_day",
    label: "My Day",
    submodules: [
      { key: "delegated_recurring", label: "Delegated & Recurring" },
      { key: "fms_tasks", label: "FMS Tasks" },
      { key: "role_view", label: "Manager/Role View" },
    ],
  },
  {
    key: "delegation_task",
    label: "Delegation Task",
    submodules: [{ key: "delegation_task", label: "Delegation Task Main" }],
  },
  {
    key: "task_reassigning",
    label: "Task Reassignment",
    submodules: [{ key: "task_reassigning", label: "Task Reassignment Main" }],
  },
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
  {
    key: "reports",
    label: "Reports",
    submodules: [
      { key: "mis_reports", label: "MIS Reports" },
      { key: "fms_reports", label: "FMS Reports" },
    ],
  },
  {
    key: "my_bucket",
    label: "My Bucket",
    submodules: [{ key: "my_bucket", label: "My Bucket Main" }],
  },
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
  {
    key: "module_management",
    label: "Module Setting",
    submodules: [{ key: "module_setting", label: "Module Setting Main" }],
  },
];

export const ALL_SUBMODULE_KEYS = SYSTEM_MODULES.flatMap((m) =>
  m.submodules.map((s) => s.key),
);
