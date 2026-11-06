const pool = require('../config/db');

// Employee Master change history: one row per field that changed, saying who
// changed it and when. Written from the same functions that actually save an
// employee, so it covers a direct Admin edit, a change applied after approval,
// the quick status toggle, bulk actions and the Excel import alike.

// Fields that are compared on an edit, with the label shown in the export.
const TRACKED = [
  ['employee_id', 'Employee ID'],
  ['full_name', 'Full name'],
  ['relative_name', "Father's/Mother's/Spouse's name"],
  ['relation', 'Relation'],
  ['designation', 'Designation'],
  ['uan', 'UAN'],
  ['bank_account_no', 'Bank account number'],
  ['establishment_name', 'Establishment'],
  ['active_from', 'Active from'],
  ['inactive_date', 'Inactive date'],
  ['status', 'Status'],
  ['email', 'Email'],
  ['app_access', 'App access'],
  ['salary_slip_access', 'Salary slip access']
];

const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// A DATE column comes back as local midnight; an Excel date cell as UTC
// midnight. Either way the calendar day written down is the one intended.
function dayOf(d) {
  const localMidnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  const utcMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  if (!localMidnight && utcMidnight) return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return dateText(d);
}

function norm(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : dayOf(v);
  return String(v).trim().slice(0, 255);
}

// Who is making the change. `req` for a direct action by a signed-in staff
// account; for an action applied later through the approval workflow, the
// requester (changed_by) and the approver are looked up/passed in.
function actorFromReq(req) {
  if (!req || !req.user) return { name: 'system', role: null, approvedBy: null };
  return { name: req.user.userId || req.user.employeeId || 'unknown', role: req.user.roleName || null, approvedBy: null };
}

async function actorFromRequester(requestedById, approver) {
  let name = 'unknown';
  let role = null;
  if (requestedById) {
    try {
      const [[u]] = await pool.query(
        'SELECT u.user_id, r.role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?', [requestedById]
      );
      if (u) { name = u.user_id; role = u.role_name; }
    } catch (e) { /* history is best-effort */ }
  }
  return { name, role, approvedBy: approver && approver.userId ? approver.userId : null };
}

// Writes rows. Never lets a logging problem break the real save.
async function writeRows(db, rows) {
  if (!rows.length) return;
  try {
    await db.query(
      `INSERT INTO employee_change_log
        (employee_id, employee_code, employee_name, action, field_name, old_value, new_value, effective_from, changed_by, changed_by_role, approved_by)
       VALUES ?`,
      [rows]
    );
  } catch (err) {
    console.error('Failed to write employee change log:', err.message);
  }
}

const row = (emp, action, field, oldV, newV, effective, actor) => [
  emp.id || null, emp.employee_id || '', emp.full_name || null, action, field,
  oldV === '' ? null : oldV, newV === '' ? null : newV, effective || null,
  actor.name, actor.role, actor.approvedBy
];

// before / after are plain objects using the TRACKED keys (establishment_name
// rather than the establishment id). Logs only what really changed.
async function logFieldChanges(db, emp, before, after, actor, effective = null, action = 'UPDATE') {
  const rows = [];
  for (const [key, label] of TRACKED) {
    if (!(key in after)) continue;
    const a = norm(before[key]);
    const b = norm(after[key]);
    if (a !== b) rows.push(row(emp, action, label, a, b, effective, actor));
  }
  await writeRows(db, rows);
  return rows.length;
}

async function logEvent(db, emp, action, field, oldV, newV, actor, effective = null) {
  await writeRows(db, [row(emp, action, field, norm(oldV), norm(newV), effective, actor)]);
}

// What a created employee looks like, as a one-line summary.
function createdSummary(e) {
  return [e.full_name, e.designation, e.establishment_name].filter(Boolean).join(' / ');
}

module.exports = { TRACKED, norm, actorFromReq, actorFromRequester, logFieldChanges, logEvent, createdSummary };
