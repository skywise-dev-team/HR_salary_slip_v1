const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange, requireAdmin } = require('../middleware/auth');
const { excelImport } = require('../middleware/upload');
const { sendTemplate, sendDataExport } = require('../utils/excelTemplates');
const { startImportProgress } = require('../utils/importProgress');
const { findNullCellProblems, nullCellErrorMessage } = require('../utils/nullCellCheck');
const { logActivity } = require('../utils/activityLog');
const { isAdminUser, createApprovalRequest } = require('../utils/approvals');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

// UAN is mandatory, and must be exactly 12 digits — not fewer, not more.
// Enforced here on the server (not just any frontend pattern attribute) so
// it can't be bypassed by a direct API call or bulk Excel import. Returns
// an error string, or null when the value is acceptable.
function validateUan(uan) {
  if (uan == null || String(uan).trim() === '') return 'UAN is required';
  if (!/^\d{12}$/.test(String(uan).trim())) return 'UAN must be exactly 12 digits';
  return null;
}

// Computes the login-related columns to WRITE for an employee, given the
// requested app_access value and (for an edit) the row's current values.
// Turning access ON — whether for the first time, or re-granting it after
// it was off — always issues a brand-new default password (the Employee ID
// itself) and forces a password change on next sign-in, exactly like a
// first-time login. Turning access OFF clears the stored password
// entirely. If access is already ON and stays ON, the existing password is
// left completely untouched — this is never a way to reset someone's
// password. `existing` is the employee's current { app_access,
// password_hash, must_change_password } — pass null for a brand-new
// employee that doesn't exist yet.
async function computeLoginFields(employeeId, requestedAppAccess, existing) {
  const appAccess = requestedAppAccess === 'YES' ? 'YES' : 'NO';
  const wasOn = existing?.app_access === 'YES';
  if (appAccess === 'YES' && !wasOn) {
    return { appAccess, passwordHash: await bcrypt.hash(employeeId, 10), mustChangePassword: 1 };
  }
  if (appAccess === 'NO') {
    return { appAccess, passwordHash: null, mustChangePassword: 1 };
  }
  return { appAccess, passwordHash: existing.password_hash, mustChangePassword: existing.must_change_password };
}

// When an employee record becomes Active, any OTHER employee record sharing
// the same UAN — the one mandatory, unique-per-person field — represents
// the same real person under a different Employee ID (most commonly a
// leftover from an ID-change transfer, or a duplicate reactivated by
// mistake). Only one such record should ever be Active at a time, so
// activating one here automatically deactivates every other one sharing
// that UAN, closes their posting history, and revokes its own app access
// (clearing its password) too — since an inactive employee record should
// never retain login access. A record with no UAN can't be reliably
// matched this way and is left alone. `db` is an optional connection to
// run on (e.g. a bulk import's transaction) — defaults to the shared pool
// for regular request use.
async function deactivateOtherActiveDuplicates(uan, excludeEmployeeId, db = pool) {
  if (!uan) return [];
  const [dupes] = await db.query(
    "SELECT id, employee_id FROM employees WHERE uan = ? AND status = 'ACTIVE' AND id != ?",
    [uan, excludeEmployeeId]
  );
  for (const dupe of dupes) {
    await db.query(
      "UPDATE employees SET status = 'INACTIVE', app_access = 'NO', password_hash = NULL WHERE id = ?",
      [dupe.id]
    );
    await db.query(
      "UPDATE employee_post_hist SET active_to = CURDATE() WHERE employee_id = ? AND active_to IS NULL",
      [dupe.id]
    );
  }
  return dupes;
}

function dupeNote(dupes) {
  if (!dupes.length) return undefined;
  return `Also set ${dupes.map((d) => d.employee_id).join(', ')} to Inactive — same UAN, and only one active record per employee is allowed.`;
}

const SALARY_SLIP_ACCESS_VALUES = ['VIEW_DOWNLOAD', 'VIEW_ONLY', 'NO_ACCESS'];

const TEMPLATE_HEADERS = [
  'employee_id', 'full_name', 'relative_name', 'relation', 'designation',
  'uan', 'bank_account_no', 'establishment_code', 'active_from', 'status',
  'email', 'app_access', 'salary_slip_access'
];
const TEMPLATE_EXAMPLE = [
  '11005001', 'Jane Doe', 'John Doe', 'Father', 'Executive',
  '100234576819', '1234567895073', 'AMPL', '2026-01-01', 'ACTIVE',
  'jane.doe@example.com', 'YES', 'VIEW_ONLY'
];

router.get('/template', requirePermission('employees', 'edit'), async (req, res) => {
  const [establishments] = await pool.query('SELECT est_code FROM establishments ORDER BY est_code');
  const validations = [
    { column: 'establishment_code', values: establishments.map((e) => e.est_code) },
    { column: 'status', values: ['ACTIVE', 'INACTIVE'] },
    { column: 'app_access', values: ['YES', 'NO'] },
    { column: 'salary_slip_access', values: SALARY_SLIP_ACCESS_VALUES }
  ];
  await sendTemplate(res, 'employee-master-template.xlsx', TEMPLATE_HEADERS, TEMPLATE_EXAMPLE, validations);
});

// NOTE: these /bulk/* routes must stay registered before /:id and
// /:id/status below — otherwise Express would match "bulk" as the :id
// parameter of those routes instead.
router.patch('/bulk/status', requirePermission('employees', 'edit'), async (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: 'No employees selected' });
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ message: 'Invalid status' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'employees', action: 'BULK_STATUS_CHANGE', payload: { ids, status },
      description: `Bulk set ${ids.length} employee(s) to ${status}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const notes = [];
  for (const id of ids) {
    const result = await applyStatusChangeEmployee(id, status);
    if (result.note) notes.push(result.note);
  }

  res.json({
    message: `${ids.length} employee(s) updated${notes.length ? '; ' + notes.join(' ') : ''}`,
    count: ids.length
  });
  await logActivity(req, 'STATUS_CHANGE', 'employees', `Bulk set ${ids.length} employee(s) to ${status}`);
});

// Deletes as many of the given employees as possible in exactly two
// queries, regardless of how many are selected — one to find which of them
// have salary records referencing them (those can't be deleted outright),
// and one to delete the rest in a single statement. A one-row-at-a-time
// loop was the original approach here, needed to let some employees delete
// successfully even if others are FK-blocked — but for a selection in the
// thousands, that meant thousands of sequential round trips to the
// database, which could take minutes and look like it had simply frozen or
// failed. This achieves the identical "graceful partial success" behavior
// without that cost.
async function bulkDeleteEmployees(ids) {
  if (!ids.length) return { deleted: 0, blocked: [] };
  const placeholders = ids.map(() => '?').join(',');
  const [blockedRows] = await pool.query(
    `SELECT DISTINCT employee_id FROM salary_data WHERE employee_id IN (${placeholders})`,
    ids
  );
  const blockedSet = new Set(blockedRows.map((r) => String(r.employee_id)));
  const deletableIds = ids.filter((id) => !blockedSet.has(String(id)));
  const blocked = ids.filter((id) => blockedSet.has(String(id)));

  let deleted = 0;
  if (deletableIds.length) {
    const delPlaceholders = deletableIds.map(() => '?').join(',');
    const [result] = await pool.query(`DELETE FROM employees WHERE id IN (${delPlaceholders})`, deletableIds);
    deleted = result.affectedRows;
  }
  return { deleted, blocked };
}

router.delete('/bulk', requirePermission('employees', 'delete'), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: 'No employees selected' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'employees', action: 'BULK_DELETE', payload: { ids },
      description: `Bulk delete ${ids.length} employee(s)`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const { deleted, blocked } = await bulkDeleteEmployees(ids);

  const message = blocked.length
    ? `${deleted} employee(s) deleted. ${blocked.length} could not be deleted because they have salary records linked to them — set them to Inactive instead.`
    : `${deleted} employee(s) deleted`;
  res.json({ message, count: deleted, blocked });
  if (deleted) await logActivity(req, 'DELETE', 'employees', `Bulk deleted ${deleted} employee(s)`);
});

const LIST_SQL = `
  SELECT e.id, e.employee_id, e.full_name, e.relative_name, e.relation, e.designation,
         e.uan, e.bank_account_no, e.establishment_id, e.active_from, e.status,
         e.email, e.app_access, e.salary_slip_access, e.must_change_password,
         e.created_at, e.updated_at,
         es.name AS establishment_name
  FROM employees e
  JOIN establishments es ON es.id = e.establishment_id`;

function buildEmployeeFilters(query) {
  const { search, establishment_id, status } = query;
  const clauses = [];
  const params = [];
  if (search) {
    clauses.push('(e.employee_id LIKE ? OR e.full_name LIKE ? OR e.designation LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (establishment_id) { clauses.push('e.establishment_id = ?'); params.push(establishment_id); }
  if (status) { clauses.push('e.status = ?'); params.push(status); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Exports full posting HISTORY — one row per employee_post_hist entry, so an
// employee transferred 3 times produces 3 rows (each with that period's own
// establishment and active-from/to dates), not one row per employee.
// employee_post_hist only stores employee_id/establishment_id/active_from/
// active_to (per the schema, unchanged) — the employee's own details (name,
// UAN, etc.) live on the employees table and are joined in here.
// NOTE: this reflects establishment transfers only. The schema stores each
// employee's current Active/Inactive status as a single field with no log of
// past status changes, so "Current Status" is the same value on every row
// for that employee (their status right now) — not a history of when they
// were activated/deactivated.
router.get('/export-history', requirePermission('employees', 'view'), async (req, res) => {
  const { search, establishment_id, status } = req.query;
  const clauses = [];
  const params = [];
  if (search) {
    clauses.push('(e.employee_id LIKE ? OR e.full_name LIKE ? OR e.designation LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (establishment_id) { clauses.push('h.establishment_id = ?'); params.push(establishment_id); }
  if (status) { clauses.push('e.status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT e.employee_id, e.full_name, e.relative_name, e.relation, e.designation,
            e.uan, e.bank_account_no, e.status AS current_status,
            hes.name AS period_establishment, h.active_from AS period_active_from, h.active_to AS period_active_to
     FROM employee_post_hist h
     JOIN employees e ON e.id = h.employee_id
     JOIN establishments hes ON hes.id = h.establishment_id
     ${where}
     ORDER BY e.full_name, h.active_from ASC`,
    params
  );

  const headers = [
    'Employee ID', 'Full Name', "Father's/Mother's/Spouse's Name", 'Relation', 'Designation',
    'UAN', 'Bank Account No', 'Establishment (this period)', 'Active From (this period)',
    'Active To (this period)', 'Current Posting?', 'Current Status'
  ];
  const dataRows = rows.map((r) => [
    r.employee_id, r.full_name, r.relative_name || '', r.relation || '', r.designation || '',
    r.uan || '', r.bank_account_no || '', r.period_establishment,
    r.period_active_from ? new Date(r.period_active_from).toISOString().slice(0, 10) : '',
    r.period_active_to ? new Date(r.period_active_to).toISOString().slice(0, 10) : '',
    r.period_active_to ? 'No' : 'Yes',
    r.current_status
  ]);

  await sendDataExport(res, 'employees-history-export.xlsx', headers, dataRows);
});

router.get('/', requirePermission('employees', 'view'), async (req, res) => {
  const { where, params } = buildEmployeeFilters(req.query);
  const [rows] = await pool.query(`${LIST_SQL} ${where} ORDER BY e.full_name`, params);
  res.json(rows);
});

router.get('/:id', requirePermission('employees', 'view'), async (req, res) => {
  const [[row]] = await pool.query(`${LIST_SQL} WHERE e.id = ?`, [req.params.id]);
  if (!row) return res.status(404).json({ message: 'Employee not found' });
  res.json(row);
});

router.get('/:id/history', requirePermission('employees', 'view'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT h.*, es.name AS establishment_name FROM employee_post_hist h
     JOIN establishments es ON es.id = h.establishment_id
     WHERE h.employee_id = ? ORDER BY h.active_from DESC`,
    [req.params.id]
  );
  res.json(rows);
});

// Applies an employee creation directly — used both for an Admin's
// immediate action and for applying an approved request later. Throws with
// a `.status` set for a validation-style error (caller turns that into the
// matching HTTP response); a MySQL duplicate-key error is left for the
// caller to detect via err.code, same as before this was extracted.
async function applyCreateEmployee(body) {
  const {
    employee_id, full_name, relative_name, relation, designation,
    uan, bank_account_no, establishment_id, active_from, status,
    email, app_access, salary_slip_access
  } = body;

  if (!employee_id || !full_name || !establishment_id) {
    const err = new Error('Employee ID, full name and establishment are required');
    err.status = 400;
    throw err;
  }
  const uanError = validateUan(uan);
  if (uanError) { const err = new Error(uanError); err.status = 400; throw err; }

  const requestedAppAccess = (status || 'ACTIVE') === 'INACTIVE' ? 'NO' : (app_access === 'YES' ? 'YES' : 'NO');
  const requestedSalaryAccess = SALARY_SLIP_ACCESS_VALUES.includes(salary_slip_access) ? salary_slip_access : 'VIEW_ONLY';

  const loginFields = await computeLoginFields(employee_id, requestedAppAccess, null);
  const [result] = await pool.query(
    `INSERT INTO employees
      (employee_id, full_name, relative_name, relation, designation, uan, bank_account_no,
       establishment_id, active_from, status, email, password_hash, app_access, salary_slip_access, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [employee_id, full_name, relative_name || null, relation || null, designation || null,
     uan || null, bank_account_no || null, establishment_id, active_from || null, status || 'ACTIVE',
     email || null, loginFields.passwordHash, loginFields.appAccess, requestedSalaryAccess, loginFields.mustChangePassword]
  );

  await pool.query(
    `INSERT INTO employee_post_hist (employee_id, establishment_id, active_from) VALUES (?, ?, ?)`,
    [result.insertId, establishment_id, active_from || new Date()]
  );

  let note;
  if ((status || 'ACTIVE') === 'ACTIVE') {
    note = dupeNote(await deactivateOtherActiveDuplicates(uan, result.insertId));
  }
  return { id: result.insertId, note };
}

router.post('/', requirePermission('employees', 'edit'), async (req, res) => {
  if (!isAdminUser(req)) {
    if (!req.body.employee_id || !req.body.full_name || !req.body.establishment_id) {
      return res.status(400).json({ message: 'Employee ID, full name and establishment are required' });
    }
    const uanError = validateUan(req.body.uan);
    if (uanError) return res.status(400).json({ message: uanError });

    await createApprovalRequest({
      req, moduleKey: 'employees', action: 'CREATE', payload: req.body,
      description: `Create employee ${req.body.employee_id} (${req.body.full_name})`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    const result = await applyCreateEmployee(req.body);
    res.status(201).json(result);
    await logActivity(req, 'CREATE', 'employees', `Created employee ${req.body.employee_id} (${req.body.full_name})`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Employee ID already exists' });
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});

// Applies a normal (non-ID-transfer) employee edit directly — same
// reasoning as applyCreateEmployee above. Re-fetches `existing` itself
// rather than trusting a value passed in, since this may run long after
// the original request (once approved), by which point the record could
// have changed again in the meantime.
async function applyUpdateEmployee(id, body) {
  const {
    full_name, relative_name, relation, designation,
    uan, bank_account_no, establishment_id, active_from, status,
    email, app_access, salary_slip_access
  } = body;

  const [[existing]] = await pool.query('SELECT * FROM employees WHERE id = ?', [id]);
  if (!existing) { const err = new Error('Employee not found'); err.status = 404; throw err; }

  const uanError = validateUan(uan);
  if (uanError) { const err = new Error(uanError); err.status = 400; throw err; }

  const requestedAppAccess = app_access === 'YES' ? 'YES' : 'NO';
  const requestedSalaryAccess = SALARY_SLIP_ACCESS_VALUES.includes(salary_slip_access) ? salary_slip_access : 'VIEW_ONLY';
  // An Inactive employee can never retain app access, regardless of what
  // was chosen in the App Access field — the reverse isn't forced (an
  // Active employee can legitimately have App Access = No).
  const normalEditAppAccess = (status || 'ACTIVE') === 'INACTIVE' ? 'NO' : requestedAppAccess;
  const loginFields = await computeLoginFields(existing.employee_id, normalEditAppAccess, existing);

  await pool.query(
    `UPDATE employees SET full_name=?, relative_name=?, relation=?, designation=?,
       uan=?, bank_account_no=?, establishment_id=?, active_from=?, status=?,
       email=?, password_hash=?, app_access=?, salary_slip_access=?, must_change_password=?
     WHERE id=?`,
    [full_name, relative_name || null, relation || null, designation || null,
     uan || null, bank_account_no || null, establishment_id, active_from || null, status || 'ACTIVE',
     email || null, loginFields.passwordHash, loginFields.appAccess, requestedSalaryAccess, loginFields.mustChangePassword,
     id]
  );

  if (String(existing.establishment_id) !== String(establishment_id)) {
    await pool.query(
      `UPDATE employee_post_hist SET active_to = CURDATE() WHERE employee_id = ? AND active_to IS NULL`,
      [id]
    );
    await pool.query(
      `INSERT INTO employee_post_hist (employee_id, establishment_id, active_from) VALUES (?, ?, ?)`,
      [id, establishment_id, active_from || new Date()]
    );
  }

  let note;
  if ((status || 'ACTIVE') === 'ACTIVE') {
    note = dupeNote(await deactivateOtherActiveDuplicates(uan, id));
  }
  return { note, employee_id: existing.employee_id };
}

router.put('/:id', requirePermission('employees', 'edit'), async (req, res) => {
  const {
    employee_id, full_name, relative_name, relation, designation,
    uan, bank_account_no, establishment_id, active_from, status,
    email, app_access, salary_slip_access
  } = req.body;

  const [[existing]] = await pool.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'Employee not found' });

  const uanError = validateUan(uan);
  if (uanError) return res.status(400).json({ message: uanError });

  const requestedAppAccess = app_access === 'YES' ? 'YES' : 'NO';
  const requestedSalaryAccess = SALARY_SLIP_ACCESS_VALUES.includes(salary_slip_access) ? salary_slip_access : 'VIEW_ONLY';
  const employeeIdChanged = String(existing.employee_id) !== String(employee_id);

  // A changed Employee ID means a transfer to a new identity (e.g. a new
  // establishment issuing its own ID scheme) — NOT an in-place edit of a
  // continuous record. The OLD record (old ID, old establishment) is left
  // exactly as its own historical row and marked Inactive, with its own
  // app access revoked; a genuinely NEW employee record is created for the
  // new ID and establishment, with whatever app access/salary slip access
  // was chosen for it in this same request, and that new record is the one
  // that stays Active.
  if (employeeIdChanged) {
    try {
      const loginFields = await computeLoginFields(employee_id, requestedAppAccess, null);
      const [result] = await pool.query(
        `INSERT INTO employees
          (employee_id, full_name, relative_name, relation, designation, uan, bank_account_no,
           establishment_id, active_from, status, email, password_hash, app_access, salary_slip_access, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
        [employee_id, full_name, relative_name || null, relation || null, designation || null,
         uan || null, bank_account_no || null, establishment_id, active_from || new Date(),
         email || null, loginFields.passwordHash, loginFields.appAccess, requestedSalaryAccess, loginFields.mustChangePassword]
      );
      await pool.query(
        'INSERT INTO employee_post_hist (employee_id, establishment_id, active_from) VALUES (?, ?, ?)',
        [result.insertId, establishment_id, active_from || new Date()]
      );

      // Only now that the new record exists do we close out the old one —
      // if the insert above had failed (e.g. duplicate ID), nothing below
      // runs, so the old record is never left inactivated with no successor.
      await pool.query(
        "UPDATE employees SET status = 'INACTIVE', app_access = 'NO', password_hash = NULL WHERE id = ?",
        [req.params.id]
      );
      await pool.query(
        'UPDATE employee_post_hist SET active_to = CURDATE() WHERE employee_id = ? AND active_to IS NULL',
        [req.params.id]
      );

      // Supplementary safety net: catch any OTHER stray Active record with
      // this same UAN too, beyond just the one being transferred from here.
      const extraDupes = await deactivateOtherActiveDuplicates(uan, result.insertId);
      const noteParts = [
        `Created a new active record for ID "${employee_id}". The previous record (ID "${existing.employee_id}") and its app access were set to Inactive automatically.`
      ];
      if (extraDupes.length) noteParts.push(dupeNote(extraDupes));

      await logActivity(req, 'UPDATE', 'employees', `Transferred employee ${existing.employee_id} to new ID ${employee_id}`);
      return res.status(201).json({
        message: 'Employee transferred to a new ID',
        newEmployeeId: result.insertId,
        note: noteParts.join(' ')
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: `Employee ID "${employee_id}" already exists.` });
      }
      throw err;
    }
  }

  // No ID change — a normal edit, which may still include an establishment
  // transfer under the same ID. This is the only branch of PUT /:id gated
  // behind approval — an Employee ID transfer (above) never requires it, as
  // confirmed explicitly.
  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'employees', action: 'UPDATE', targetId: req.params.id, payload: req.body,
      description: `Edit employee ${existing.employee_id}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const result = await applyUpdateEmployee(req.params.id, req.body);
  res.json({ message: 'Employee updated', note: result.note });
  await logActivity(req, 'UPDATE', 'employees', `Updated employee ${existing.employee_id}`);
});

// Applies an Active/Inactive status change (with its app-access sync)
// directly. Shared by the single toggle route below, the bulk toggle route,
// and the approval dispatcher.
async function applyStatusChangeEmployee(id, status) {
  const [[existing]] = await pool.query(
    'SELECT employee_id, uan, app_access, password_hash, must_change_password FROM employees WHERE id = ?',
    [id]
  );
  if (!existing) { const err = new Error('Employee not found'); err.status = 404; throw err; }

  const requestedAppAccess = status === 'ACTIVE' ? 'YES' : 'NO';
  const loginFields = await computeLoginFields(existing.employee_id, requestedAppAccess, existing);

  await pool.query(
    'UPDATE employees SET status = ?, app_access = ?, password_hash = ?, must_change_password = ? WHERE id = ?',
    [status, loginFields.appAccess, loginFields.passwordHash, loginFields.mustChangePassword, id]
  );

  let note;
  if (status === 'ACTIVE') {
    note = dupeNote(await deactivateOtherActiveDuplicates(existing.uan, id));
  }
  return { note, employee_id: existing.employee_id };
}

router.patch('/:id/status', requirePermission('employees', 'edit'), async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ message: 'Invalid status' });

  const [[existing]] = await pool.query('SELECT employee_id FROM employees WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'Employee not found' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'employees', action: 'STATUS_CHANGE', targetId: req.params.id, payload: { status },
      description: `Set employee ${existing.employee_id} to ${status}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const result = await applyStatusChangeEmployee(req.params.id, status);
  res.json({ message: 'Status updated', note: result.note });
  await logActivity(req, 'STATUS_CHANGE', 'employees', `Set employee ${result.employee_id} to ${status}`);
});

// Admin-only: resets an employee's login password back to their own
// Employee ID and forces them to set a new one at next sign-in. Mirrors
// the Users page's reset-password action exactly, and is restricted to the
// Admin role specifically for the same reason — this is more sensitive
// than an ordinary field edit. Only meaningful for an employee who
// currently has app access; there is no login to reset otherwise.
router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  const [[employee]] = await pool.query('SELECT id, employee_id, app_access FROM employees WHERE id = ?', [req.params.id]);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  if (employee.app_access !== 'YES') {
    return res.status(400).json({ message: 'This employee does not have app access enabled — there is no login to reset.' });
  }

  const hash = await bcrypt.hash(employee.employee_id, 10);
  await pool.query(
    'UPDATE employees SET password_hash = ?, must_change_password = 1 WHERE id = ?',
    [hash, req.params.id]
  );
  res.json({ message: `Password reset to the Employee ID (${employee.employee_id}). They must set a new password at next sign-in.` });
  await logActivity(req, 'PASSWORD_RESET', 'employees', `Reset password for employee ${employee.employee_id}`);
});

// Applies an employee deletion directly. Throws MySQL's own FK-violation
// error as-is (err.code / err.errno) for the caller to detect, same as
// before this was extracted — an employee with linked salary records can't
// be deleted outright.
async function applyDeleteEmployee(id) {
  const [[employee]] = await pool.query('SELECT employee_id FROM employees WHERE id = ?', [id]);
  await pool.query('DELETE FROM employees WHERE id = ?', [id]);
  return { employee_id: employee?.employee_id };
}

router.delete('/:id', requirePermission('employees', 'delete'), async (req, res) => {
  const [[existing]] = await pool.query('SELECT employee_id FROM employees WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'Employee not found' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'employees', action: 'DELETE', targetId: req.params.id,
      description: `Delete employee ${existing.employee_id}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    const result = await applyDeleteEmployee(req.params.id);
    res.json({ message: 'Employee deleted' });
    if (result.employee_id) await logActivity(req, 'DELETE', 'employees', `Deleted employee ${result.employee_id}`);
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
      return res.status(409).json({
        message: 'This employee has salary records (and generated slips) linked to them and cannot be deleted. Set their status to Inactive instead, or delete their salary data first if you really need to remove them.'
      });
    }
    throw err;
  }
});

// The actual per-row logic, shared by both the direct-upload path (Admin,
// streamed progress) and the approval-triggered path (everyone else,
// staged and applied later, no streaming) — kept in one place so neither
// path can drift out of sync with the other.
async function processEmployeeImportRows(conn, sheet, colIndex, results, reportProgress, isCancelled) {
  for (let r = 2; r <= sheet.rowCount; r++) {
    if (isCancelled()) break;
    reportProgress();
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;

    const get = (name) => {
      const idx = colIndex(name);
      if (idx === -1) return null;
      const v = row.getCell(idx).value;
      return v == null || v === '' ? null : String(v).trim();
    };

    const employeeId = get('employee_id');
    const fullName = get('full_name');
    const establishmentCode = get('establishment_code');
    const emailValue = get('email');
    const appAccessValue = (get('app_access') || 'NO').toUpperCase() === 'YES' ? 'YES' : 'NO';
    const salarySlipAccessRaw = (get('salary_slip_access') || 'VIEW_ONLY').toUpperCase();
    const salarySlipAccessValue = SALARY_SLIP_ACCESS_VALUES.includes(salarySlipAccessRaw) ? salarySlipAccessRaw : 'VIEW_ONLY';

    try {
      if (!establishmentCode) {
        results.errors.push(`Row ${r}: establishment_code is required`);
        results.skipped++;
        continue;
      }
      const [[est]] = await conn.query('SELECT id FROM establishments WHERE est_code = ?', [establishmentCode]);
      if (!est) {
        results.errors.push(`Row ${r}: establishment_code "${establishmentCode}" not found`);
        results.skipped++;
        continue;
      }

      const uanValue = get('uan');
      const uanError = validateUan(uanValue);
      if (uanError) {
        results.errors.push(`Row ${r}: ${uanError}`);
        results.skipped++;
        continue;
      }

      const status = (get('status') || 'ACTIVE').toUpperCase();
      const validStatus = ['ACTIVE', 'INACTIVE'].includes(status) ? status : 'ACTIVE';
      const activeFromRaw = row.getCell(colIndex('active_from')).value;
      const activeFrom = activeFromRaw instanceof Date ? activeFromRaw : (get('active_from') || null);

      // An Inactive employee can never retain app access, regardless of
      // what the sheet's app_access column says — the reverse isn't
      // forced (an Active row can legitimately have app_access = NO).
      const effectiveAppAccess = validStatus === 'INACTIVE' ? 'NO' : appAccessValue;

      // Upsert by Employee ID: a row whose ID already exists updates
      // that employee instead of failing as a duplicate, so the same
      // sheet can be re-uploaded after changing someone's details.
      const [[existing]] = await conn.query(
        'SELECT id, establishment_id, app_access, password_hash, must_change_password FROM employees WHERE employee_id = ?',
        [employeeId]
      );

      if (existing) {
        const loginFields = await computeLoginFields(employeeId, effectiveAppAccess, existing);
        await conn.query(
          `UPDATE employees SET full_name=?, relative_name=?, relation=?, designation=?, uan=?,
             bank_account_no=?, establishment_id=?, active_from=?, status=?,
             email=?, password_hash=?, app_access=?, salary_slip_access=?, must_change_password=?
           WHERE id=?`,
          [fullName, get('relative_name'), get('relation'), get('designation'), uanValue,
           get('bank_account_no'), est.id, activeFrom, validStatus,
           emailValue, loginFields.passwordHash, loginFields.appAccess, salarySlipAccessValue, loginFields.mustChangePassword,
           existing.id]
        );
        if (String(existing.establishment_id) !== String(est.id)) {
          await conn.query(
            `UPDATE employee_post_hist SET active_to = CURDATE() WHERE employee_id = ? AND active_to IS NULL`,
            [existing.id]
          );
          await conn.query(
            `INSERT INTO employee_post_hist (employee_id, establishment_id, active_from) VALUES (?, ?, ?)`,
            [existing.id, est.id, activeFrom || new Date()]
          );
        }
        if (validStatus === 'ACTIVE') {
          await deactivateOtherActiveDuplicates(uanValue, existing.id, conn);
        }
        results.updated++;
        continue;
      }

      const loginFields = await computeLoginFields(employeeId, effectiveAppAccess, null);
      const [result] = await conn.query(
        `INSERT INTO employees
          (employee_id, full_name, relative_name, relation, designation, uan, bank_account_no,
           establishment_id, active_from, status, email, password_hash, app_access, salary_slip_access, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [employeeId, fullName, get('relative_name'), get('relation'), get('designation'),
         uanValue, get('bank_account_no'), est.id, activeFrom, validStatus,
         emailValue, loginFields.passwordHash, loginFields.appAccess, salarySlipAccessValue, loginFields.mustChangePassword]
      );
      await conn.query(
        `INSERT INTO employee_post_hist (employee_id, establishment_id, active_from) VALUES (?, ?, ?)`,
        [result.insertId, est.id, activeFrom || new Date()]
      );
      if (validStatus === 'ACTIVE') {
        await deactivateOtherActiveDuplicates(uanValue, result.insertId, conn);
      }
      results.inserted++;
    } catch (err) {
      results.errors.push(`Row ${r}: ${err.message}`);
      results.skipped++;
    }
  }
}

// Runs a staged, already-validated file once its approval request is
// approved — no streaming (there's no client waiting on this one, it's
// triggered from the Approvals page, possibly days after the original
// upload), just a plain transaction and a final summary. The staged file
// itself is deleted by the Approvals route after this succeeds, not here.
async function applyImportEmployees(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const header = sheet.getRow(1).values.map((v) => (v || '').toString().trim().toLowerCase());
  const colIndex = (name) => header.indexOf(name);

  const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await processEmployeeImportRows(conn, sheet, colIndex, results, () => {}, () => false);
    await conn.commit();
    return results;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------
// Bulk import from Excel (see TEMPLATE_HEADERS above for expected columns).
// Each row can optionally grant that employee app access (app_access =
// YES) at a chosen salary_slip_access level — if so, a login is
// provisioned/updated directly on that employee's own record: password =
// Employee ID, forced password change on first sign-in.
// ---------------------------------------------------------------
router.post(
  '/import',
  requirePermission('employees', 'edit'),
  excelImport.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Excel file is required' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0];

    const header = sheet.getRow(1).values.map((v) => (v || '').toString().trim().toLowerCase());
    const colIndex = (name) => header.indexOf(name);

    // Reject the entire upload up front if any required cell anywhere in
    // the sheet is blank — nothing is saved in that case. See
    // nullCellCheck.js for the exact rule. Only genuinely mandatory columns
    // are enforced here — relative_name, relation, designation,
    // bank_account_no, active_from, and email are legitimately optional and
    // may be left blank. app_access must always be explicitly YES or NO;
    // salary_slip_access is only required (and validated) when app_access
    // is YES, via the extra row check below.
    const REQUIRED_COLUMNS = ['employee_id', 'full_name', 'uan', 'establishment_code', 'app_access'];
    const nullProblems = findNullCellProblems(sheet, colIndex, REQUIRED_COLUMNS, [], (row, ci) => {
      const appAccessIdx = ci('app_access');
      const appAccessRaw = row.getCell(appAccessIdx).value;
      const appAccessNorm = String(appAccessRaw || '').trim().toUpperCase();
      if (!['YES', 'NO'].includes(appAccessNorm)) {
        return `app_access must be YES or NO (got "${appAccessRaw}")`;
      }
      if (appAccessNorm === 'YES') {
        const salIdx = ci('salary_slip_access');
        const salRaw = salIdx === -1 ? null : row.getCell(salIdx).value;
        const salNorm = salRaw == null ? '' : String(salRaw).trim().toUpperCase();
        if (!SALARY_SLIP_ACCESS_VALUES.includes(salNorm)) {
          return `salary_slip_access is required and must be VIEW_DOWNLOAD, VIEW_ONLY, or NO_ACCESS when app_access is YES (got "${salRaw ?? ''}")`;
        }
      }
      return null;
    });
    if (nullProblems.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: nullCellErrorMessage(nullProblems) });
    }

    // Non-Admin: the file has already passed the same validation an Admin's
    // upload would — stage it for approval instead of importing it now.
    // The file is left exactly where multer already saved it
    // (uploads/imports/), referenced by staged_file_path; nothing is
    // copied, moved, or processed until an Admin approves it.
    if (!isAdminUser(req)) {
      const rowCount = Math.max(0, sheet.rowCount - 1);
      await createApprovalRequest({
        req, moduleKey: 'employees', action: 'IMPORT', stagedFilePath: req.file.path,
        description: `Bulk import ${rowCount} employee row(s)`
      });
      return res.status(202).json({ message: 'Submitted for approval, pending.' });
    }

    const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };
    const totalRows = Math.max(0, sheet.rowCount - 1);

    // Everything in this import runs inside one transaction on a dedicated
    // connection. If the request is aborted mid-way (e.g. a Cancel button
    // on the frontend), the transaction is rolled back in full so nothing
    // from a cancelled import is left in the database.
    const conn = await pool.getConnection();
    let cancelled = false;
    let reportProgress, sendDone, sendError;
    const onClose = () => { if (!res.writableEnded) cancelled = true; };
    req.on('close', onClose);

    try {
      await conn.beginTransaction();
      // Only start the streamed progress response once the transaction is
      // actually underway, so a connection/transaction failure above still
      // gets reported as a normal JSON error instead of a broken stream.
      const progress = startImportProgress(res, totalRows);
      ({ reportProgress, sendDone } = progress);
      sendError = progress.sendError;

      await processEmployeeImportRows(conn, sheet, colIndex, results, reportProgress, () => cancelled);

      if (cancelled) {
        await conn.rollback();
      } else {
        await conn.commit();
        sendDone(results);
        await logActivity(req, 'IMPORT', 'employees', `Imported employees: ${results.inserted} new, ${results.updated} updated, ${results.skipped} skipped`);
      }
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* connection may already be broken */ }
      if (!cancelled) {
        if (sendError) {
          console.error(err);
          sendError(err.message || 'Import failed due to an unexpected server error.');
        } else {
          throw err; // headers not sent yet — the central error handler sends a clean JSON response
        }
      }
    } finally {
      req.removeListener('close', onClose);
      conn.release();
      fs.unlink(req.file.path, () => {});
    }
  }
);

// Called by the Approvals routes when an Admin approves a pending request
// for this module — routes to whichever apply function matches the action
// that was staged. This is the ONLY place an approved employees request
// actually gets applied; nothing about it is duplicated from the routes
// above, which all call these same functions directly for an Admin's
// immediate action.
async function applyApprovedEmployeeAction(action, targetId, payload, requestedBy, stagedFilePath) {
  switch (action) {
    case 'CREATE':
      return applyCreateEmployee(payload);
    case 'UPDATE':
      return applyUpdateEmployee(targetId, payload);
    case 'STATUS_CHANGE':
      return applyStatusChangeEmployee(targetId, payload.status);
    case 'BULK_STATUS_CHANGE': {
      const notes = [];
      for (const id of payload.ids) {
        const result = await applyStatusChangeEmployee(id, payload.status);
        if (result.note) notes.push(result.note);
      }
      return { note: notes.join(' ') };
    }
    case 'DELETE':
      return applyDeleteEmployee(targetId);
    case 'BULK_DELETE':
      return bulkDeleteEmployees(payload.ids);
    case 'IMPORT':
      return applyImportEmployees(stagedFilePath);
    default:
      throw new Error(`Unknown action "${action}" for employees`);
  }
}

module.exports = router;
module.exports.applyApprovedAction = applyApprovedEmployeeAction;
