const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange } = require('../middleware/auth');
const { sendDataExport } = require('../utils/excelTemplates');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

const ACTION_LABELS = {
  LOGIN: 'Login',
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  IMPORT: 'Bulk Import',
  STATUS_CHANGE: 'Status Change',
  PASSWORD_RESET: 'Password Reset',
  PASSWORD_CHANGE: 'Password Change'
};

function buildFilters(query) {
  const { performed_by, role_name, action, module_key, from, to } = query;
  const clauses = [];
  const params = [];
  if (performed_by) { clauses.push('performed_by = ?'); params.push(performed_by); }
  if (role_name) { clauses.push('role_name = ?'); params.push(role_name); }
  if (action) { clauses.push('action = ?'); params.push(action); }
  if (module_key) { clauses.push('module_key = ?'); params.push(module_key); }
  if (from) { clauses.push('created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { clauses.push('created_at <= ?'); params.push(`${to} 23:59:59`); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Filterable by staff member (by their login ID, matched against the
// snapshot taken at the time — still works even if that account has since
// been deleted), role, action type, module, and a date range. Capped at the
// 1000 most recent matching rows — this table has no natural cap on size
// the way most others in the app do (one row per action, indefinitely), so
// a hard limit keeps a very broad/unfiltered query from ever returning an
// unbounded result set on screen.
router.get('/', requirePermission('activity_log', 'view'), async (req, res) => {
  const { where, params } = buildFilters(req.query);
  const [rows] = await pool.query(
    `SELECT id, performed_by, role_name, action, module_key, description, created_at
     FROM activity_log ${where} ORDER BY created_at DESC LIMIT 1000`,
    params
  );
  res.json(rows);
});

// Distinct values for the filter dropdowns, so the frontend doesn't have to
// guess what staff members/roles have ever appeared in the log.
router.get('/filters', requirePermission('activity_log', 'view'), async (req, res) => {
  const [performedBy] = await pool.query('SELECT DISTINCT performed_by FROM activity_log ORDER BY performed_by');
  const [roleNames] = await pool.query('SELECT DISTINCT role_name FROM activity_log ORDER BY role_name');
  res.json({
    performedBy: performedBy.map((r) => r.performed_by),
    roleNames: roleNames.map((r) => r.role_name),
    actions: Object.keys(ACTION_LABELS)
  });
});

// Excel export — respects exactly the same filters as the on-screen list,
// but (unlike that view) is NOT capped at 1000 rows: an exported report is
// meant to be a complete record, not just a manageable page to browse.
router.get('/export', requirePermission('activity_log', 'view'), async (req, res) => {
  const { where, params } = buildFilters(req.query);
  const [rows] = await pool.query(
    `SELECT performed_by, role_name, action, module_key, description, created_at
     FROM activity_log ${where} ORDER BY created_at DESC`,
    params
  );

  const headers = ['Date & Time', 'Staff Member', 'Role', 'Action', 'Module', 'Details'];
  const dataRows = rows.map((r) => [
    new Date(r.created_at).toLocaleString(),
    r.performed_by,
    r.role_name,
    ACTION_LABELS[r.action] || r.action,
    r.module_key || '',
    r.description
  ]);

  await sendDataExport(res, 'activity-log-export.xlsx', headers, dataRows);
});

module.exports = router;
