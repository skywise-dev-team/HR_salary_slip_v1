// Fixed module registry. Used to populate "Select Module name" on role
// creation and the rows of the "Manage Access" View/Create/Edit/Delete matrix.
const MODULES = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'establishments', label: 'Establishments' },
  { key: 'employees', label: 'Employee Master' },
  { key: 'upload_salary', label: 'Upload Salary Data' },
  { key: 'salary_slips', label: 'Salary Slips' },
  { key: 'users', label: 'Users' },
  { key: 'roles_permissions', label: 'Roles & Permissions' },
  { key: 'activity_log', label: 'Activity Log' }
];

const MODULE_KEYS = MODULES.map((m) => m.key);

module.exports = { MODULES, MODULE_KEYS };
