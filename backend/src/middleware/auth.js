const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { MODULE_KEYS } = require('../config/modules');
const { checkStaffNetwork, rejectStaffNetwork } = require('../utils/networkAccess');
const { loadEstablishmentScope } = require('../utils/establishmentScope');

// Every Employee Master login (app_access = 'YES') is attributed this one
// shared "Employee" role — Salary Slips view only, nothing else — so the
// existing requirePermission/getPermissionsMap machinery (and the frontend's
// permission checks) work completely unchanged for these sessions. The
// per-employee salary_slip_access level (view/download/none) still varies
// individually; only the module-level role is shared and fixed.
let employeeRoleTidied = false;
async function ensureEmployeeRole() {
  const [[existing]] = await pool.query("SELECT id FROM roles WHERE role_name = 'Employee'");
  if (existing) {
    // The Employee role only ever has Salary Slips (View). Anything else that
    // was ticked on it earlier is removed, once, the first time it is used.
    if (!employeeRoleTidied) {
      await pool.query("DELETE FROM role_modules WHERE role_id = ? AND module_key != 'salary_slips'", [existing.id]);
      await pool.query(
        "INSERT INTO role_modules (role_id, module_key, can_view, can_edit, can_delete) VALUES (?, 'salary_slips', 1, 0, 0) ON DUPLICATE KEY UPDATE can_view = 1, can_edit = 0, can_delete = 0",
        [existing.id]
      );
      employeeRoleTidied = true;
    }
    return existing.id;
  }

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

    // Staff sessions are re-checked against the company network on EVERY
    // request, not just at login — otherwise a token from a login done
    // in the office would keep working from anywhere until it expires.
    // Employee sessions (handled above) are never restricted.
    const network = checkStaffNetwork(req);
    if (!network.allowed) return rejectStaffNetwork(res, network.ip);

    const [[user]] = await pool.query(
      `SELECT u.id, u.user_id, u.email, u.status, u.role_id, u.must_change_password, u.all_establishments, u.can_approve, r.role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [payload.id]
    );
    if (!user || user.status !== 'ACTIVE') {
      return res.status(401).json({ message: 'Account is inactive or no longer exists' });
    }

    const permissions = await getPermissionsMap(user.role_id, user.role_name);
    // null = every establishment; a list = only those (see utils/establishmentScope.js).
    const estScope = await loadEstablishmentScope(user.id, user.role_name, !!user.all_establishments);

    req.user = {
      id: user.id,
      userId: user.user_id,
      email: user.email,
      roleId: user.role_id,
      roleName: user.role_name,
      // A staff account's Salary Slips download right comes from its
      // role's own entry for that module in Roles & Permissions — see
      // salarySlipAccessFor() below.
      salarySlipAccess: salarySlipAccessFor(permissions),
      estScope,
      canApprove: !!user.can_approve,
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

// For the Approvals screen: any staff account that has "Can approve" turned on
// (any role, not only Admin). Which requests it actually sees is decided per
// request - see isVisibleTo in routes/approvals.js.
function requireApprover(req, res, next) {
  if (req.user?.source !== 'user' || !req.user.canApprove) {
    return res.status(403).json({ message: 'You are not set up as an approver' });
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

// Passes when the role may VIEW at least one of the listed modules. Used by
// the small lookup lists (establishment / employee pick-lists) that several
// screens need, so e.g. Upload Salary Data works without also being given the
// Establishments or Employees module.
function requireAnyView(moduleKeys) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (req.user.roleName === 'Admin') return next();
    const [rows] = await pool.query(
      `SELECT 1 FROM role_modules WHERE role_id = ? AND can_view = 1 AND module_key IN (${moduleKeys.map(() => '?').join(',')}) LIMIT 1`,
      [req.user.roleId, ...moduleKeys]
    );
    if (!rows.length) return res.status(403).json({ message: 'You do not have permission to perform this action' });
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
// A staff (users-table) account's Salary Slips access, derived from its
// role's Roles & Permissions entry for the Salary Slips module:
//   View ticked      -> preview and download
//   View not ticked  -> no access
// (Salary Slips has no Edit / Delete permission.)
// The Admin role always has every permission, so it always gets View &
// Download. (Employee self-service logins don't use this - theirs is set
// per employee in Employee Master.)
function salarySlipAccessFor(permissions) {
  const p = permissions?.salary_slips;
  if (p?.view) return 'VIEW_DOWNLOAD';
  return 'NO_ACCESS';
}

async function getAllowedModules(roleId, roleName) {
  const map = await getPermissionsMap(roleId, roleName);
  return Object.keys(map).filter((key) => map[key].view);
}

module.exports = { requireAuth, requirePermission, requireAnyView, requireNotPendingPasswordChange, requireAdmin, requireApprover, getAllowedModules, getPermissionsMap, ensureEmployeeRole, salarySlipAccessFor };
