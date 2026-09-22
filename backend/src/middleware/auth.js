const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { MODULE_KEYS } = require('../config/modules');

// Every Employee Master login (app_access = 'YES') is attributed this one
// shared "Employee" role — Salary Slips view only, nothing else — so the
// existing requirePermission/getPermissionsMap machinery (and the frontend's
// permission checks) work completely unchanged for these sessions. The
// per-employee salary_slip_access level (view/download/none) still varies
// individually; only the module-level role is shared and fixed.
async function ensureEmployeeRole() {
  const [[existing]] = await pool.query("SELECT id FROM roles WHERE role_name = 'Employee'");
  if (existing) return existing.id;

  const [result] = await pool.query(
    "INSERT INTO roles (role_name, description) VALUES ('Employee', 'Shared role for Employee Master logins — view-only access to their own salary slips')"
  );
  const roleId = result.insertId;
  await pool.query(
    'INSERT IGNORE INTO role_modules (role_id, module_key, can_view, can_edit, can_delete) VALUES (?, ?, 1, 0, 0)',
    [roleId, 'salary_slips']
  );
  return roleId;
}

// Verifies the JWT and attaches a consistent req.user shape regardless of
// which table this session's credentials actually live in:
//   - source: 'user'     -> a staff account from the `users` table (Admin,
//                            HR, Super Admin, or any other manually-created
//                            account with its own role and permissions).
//   - source: 'employee' -> an Employee Master-provisioned login. Its role
//                            is always the shared "Employee" role above, and
//                            req.user.id is directly the employees.id row —
//                            no further lookup is needed anywhere else in
//                            the app to know which employee this is.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token || null;
  if (!token) return res.status(401).json({ message: 'Missing authentication token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (payload.source === 'employee') {
      const [[emp]] = await pool.query(
        `SELECT id, employee_id, full_name, email, status, app_access, salary_slip_access, must_change_password
         FROM employees WHERE employee_id = ?`,
        [payload.employeeId]
      );
      if (!emp || emp.status !== 'ACTIVE' || emp.app_access !== 'YES') {
        return res.status(401).json({ message: 'Account is inactive or no longer exists' });
      }
      const roleId = await ensureEmployeeRole();
      req.user = {
        id: emp.id,
        userId: emp.employee_id,
        fullName: emp.full_name,
        email: emp.email,
        roleId,
        roleName: 'Employee',
        salarySlipAccess: emp.salary_slip_access,
        mustChangePassword: !!emp.must_change_password,
        source: 'employee'
      };
      return next();
    }

    const [[user]] = await pool.query(
      `SELECT u.id, u.user_id, u.email, u.status, u.role_id, u.must_change_password, r.role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [payload.id]
    );
    if (!user || user.status !== 'ACTIVE') {
      return res.status(401).json({ message: 'Account is inactive or no longer exists' });
    }

    req.user = {
      id: user.id,
      userId: user.user_id,
      email: user.email,
      roleId: user.role_id,
      roleName: user.role_name,
      // Every users-table (staff) account always has full Salary Slips
      // access — this is a fixed policy, not a per-account setting, so
      // there's no column for it anymore; it's hardcoded here instead.
      salarySlipAccess: 'VIEW_DOWNLOAD',
      mustChangePassword: !!user.must_change_password,
      source: 'user'
    };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

// Blocks every business-data endpoint until a first-login password change is
// done. Applied to every resource router except auth.js itself, so /me,
// /login and /change-password always stay reachable.
function requireNotPendingPasswordChange(req, res, next) {
  if (req.user?.mustChangePassword) {
    return res.status(403).json({ message: 'You must change your password before continuing', code: 'MUST_CHANGE_PASSWORD' });
  }
  next();
}

// For actions restricted to the Admin role specifically — stricter than the
// per-module can_view/can_edit/can_delete permission matrix, which other
// roles could otherwise be granted for the 'users' module.
function requireAdmin(req, res, next) {
  if (req.user?.roleName !== 'Admin') {
    return res.status(403).json({ message: 'Only Admin can perform this action' });
  }
  next();
}

// Factory: requirePermission('employees', 'view'|'edit'|'delete')
function requirePermission(moduleKey, action = 'view') {
  const column = { view: 'can_view', edit: 'can_edit', delete: 'can_delete' }[action];

  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

    // The seeded Admin role always has full access.
    if (req.user.roleName === 'Admin') return next();

    const [[perm]] = await pool.query(
      `SELECT ${column} AS allowed FROM role_modules WHERE role_id = ? AND module_key = ?`,
      [req.user.roleId, moduleKey]
    );

    if (!perm || !perm.allowed) {
      return res.status(403).json({ message: 'You do not have permission to perform this action' });
    }
    next();
  };
}

// Full { view, edit, delete } matrix for every module, for this role.
// Admin gets everything true regardless of what's stored in role_modules.
async function getPermissionsMap(roleId, roleName) {
  const map = {};
  MODULE_KEYS.forEach((key) => { map[key] = { view: false, edit: false, delete: false }; });

  if (roleName === 'Admin') {
    MODULE_KEYS.forEach((key) => { map[key] = { view: true, edit: true, delete: true }; });
    return map;
  }

  const [rows] = await pool.query(
    'SELECT module_key, can_view, can_edit, can_delete FROM role_modules WHERE role_id = ?',
    [roleId]
  );
  rows.forEach((r) => {
    if (map[r.module_key]) {
      map[r.module_key] = { view: !!r.can_view, edit: !!r.can_edit, delete: !!r.can_delete };
    }
  });
  return map;
}

// The list of module keys this role is allowed to *see* (can_view = 1).
async function getAllowedModules(roleId, roleName) {
  const map = await getPermissionsMap(roleId, roleName);
  return Object.keys(map).filter((key) => map[key].view);
}

module.exports = { requireAuth, requirePermission, requireNotPendingPasswordChange, requireAdmin, getAllowedModules, getPermissionsMap, ensureEmployeeRole };
