const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { requireAuth, getPermissionsMap, ensureEmployeeRole } = require('../middleware/auth');
const { logActivity, logLogin } = require('../utils/activityLog');

const router = asyncRouter();

// Builds the successful-login response for a staff (users-table) account.
// Shared by the single-account path and the both-accounts-exist path once
// "staff" has been explicitly chosen.
async function completeStaffLogin(user, res) {
  const token = jwt.sign({ id: user.id, source: 'user' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30m'
  });
  const permissions = await getPermissionsMap(user.role_id, user.role_name);
  const allowedModules = Object.keys(permissions).filter((key) => permissions[key].view);
  await logLogin(user);
  // A notification already read stays visible for the rest of that same
  // session (so someone can still find what they've already seen), but is
  // cleared out the next time they actually log back in — read
  // notifications from a prior session are done being useful.
  await pool.query('DELETE FROM notifications WHERE user_id = ? AND is_read = 1', [user.id]);

  res.json({
    token,
    user: {
      id: user.id,
      userId: user.user_id,
      email: user.email,
      role: user.role_name,
      // Every users-table (staff) account always has full Salary Slips
      // access — a fixed policy, not a per-account setting.
      salarySlipAccess: 'VIEW_DOWNLOAD',
      mustChangePassword: !!user.must_change_password,
      allowedModules,
      permissions
    }
  });
}

// Builds the successful-login response for an Employee Master-provisioned
// account. Shared the same way as completeStaffLogin above.
async function completeEmployeeLogin(emp, res) {
  const roleId = await ensureEmployeeRole();
  // The token identifies this session by the stable Employee ID string, not
  // the internal auto-increment row id. That id is just a surrogate key for
  // this row — if the employees table is ever reset, re-imported, or a row
  // is deleted and a new one takes over the same numeric id, a still-valid
  // token embedding that raw id would silently resolve to whichever
  // employee now happens to sit at that id, not the person who actually
  // logged in. Looking the row up fresh by employee_id on every request
  // (see requireAuth) closes that off entirely.
  const token = jwt.sign({ employeeId: emp.employee_id, source: 'employee' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30m'
  });
  const permissions = await getPermissionsMap(roleId, 'Employee');
  const allowedModules = Object.keys(permissions).filter((key) => permissions[key].view);

  res.json({
    token,
    user: {
      id: emp.id,
      userId: emp.employee_id,
      fullName: emp.full_name,
      email: emp.email,
      role: 'Employee',
      salarySlipAccess: emp.salary_slip_access,
      mustChangePassword: !!emp.must_change_password,
      allowedModules,
      permissions
    }
  });
}

router.post('/login', async (req, res) => {
  const { userId, password, accountType } = req.body;
  if (!userId || !password) return res.status(400).json({ message: 'User ID and password are required' });

  // A single ID can legitimately belong to both a staff account (e.g. HR
  // or Admin, created on the Users page) and an Employee Master record —
  // the same real person, wearing two hats, such as an HR staff member who
  // is also paid through the system as an employee. BINARY makes both
  // lookups case-sensitive — "HR1" and "hr1" are different accounts.
  const [[staffUser]] = await pool.query(
    `SELECT u.*, r.role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE BINARY u.user_id = ?`,
    [userId]
  );
  const [[emp]] = await pool.query('SELECT * FROM employees WHERE BINARY employee_id = ?', [userId]);
  const empHasLogin = !!emp && emp.app_access === 'YES' && !!emp.password_hash;

  if (staffUser && empHasLogin) {
    // Both exist for this ID. Freshly-provisioned accounts on both sides
    // default their password to the ID itself, so the two could easily be
    // identical — there's no safe way to guess which one is meant from the
    // password alone. Always ask explicitly instead, every single time,
    // rather than trying to be clever about it.
    if (accountType !== 'staff' && accountType !== 'employee') {
      return res.json({
        needsAccountType: true,
        message: 'This ID is used by both a staff account and an employee account. Please choose which one to log into.'
      });
    }
    if (accountType === 'staff') {
      if (staffUser.status !== 'ACTIVE') return res.status(403).json({ message: 'This account is inactive' });
      const ok = await bcrypt.compare(password, staffUser.password_hash);
      if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
      return completeStaffLogin(staffUser, res);
    } else {
      if (emp.status !== 'ACTIVE') return res.status(403).json({ message: 'This account is inactive' });
      const ok = await bcrypt.compare(password, emp.password_hash);
      if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
      return completeEmployeeLogin(emp, res);
    }
  }

  if (staffUser) {
    if (staffUser.status !== 'ACTIVE') return res.status(403).json({ message: 'This account is inactive' });
    const ok = await bcrypt.compare(password, staffUser.password_hash);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    return completeStaffLogin(staffUser, res);
  }

  if (empHasLogin) {
    if (emp.status !== 'ACTIVE') return res.status(403).json({ message: 'This account is inactive' });
    const ok = await bcrypt.compare(password, emp.password_hash);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    return completeEmployeeLogin(emp, res);
  }

  return res.status(401).json({ message: 'Invalid credentials' });
});

router.get('/me', requireAuth, async (req, res) => {
  const permissions = await getPermissionsMap(req.user.roleId, req.user.roleName);
  const allowedModules = Object.keys(permissions).filter((key) => permissions[key].view);

  res.json({
    user: {
      id: req.user.id,
      userId: req.user.userId,
      fullName: req.user.fullName,
      email: req.user.email,
      role: req.user.roleName,
      salarySlipAccess: req.user.salarySlipAccess,
      mustChangePassword: req.user.mustChangePassword,
      allowedModules,
      permissions
    }
  });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current and new password are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters' });
  }

  // Write back to whichever table this session's credentials actually live
  // in. `table` is always one of these two hardcoded literals — never
  // derived from request input — so building the query string this way
  // carries no SQL-injection risk.
  const table = req.user.source === 'employee' ? 'employees' : 'users';
  const [[row]] = await pool.query(`SELECT password_hash FROM ${table} WHERE id = ?`, [req.user.id]);
  const ok = await bcrypt.compare(currentPassword, row.password_hash);
  if (!ok) return res.status(400).json({ message: 'Current password is incorrect' });

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE ${table} SET password_hash = ?, must_change_password = 0 WHERE id = ?`, [hash, req.user.id]);
  await logActivity(req, 'PASSWORD_CHANGE', null, 'Changed their own password');
  res.json({ message: 'Password updated successfully' });
});

module.exports = router;
