const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const fs = require('fs');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange, requireAdmin } = require('../middleware/auth');
const { excelImport } = require('../middleware/upload');
const { sendTemplate } = require('../utils/excelTemplates');
const { startImportProgress } = require('../utils/importProgress');
const { findNullCellProblems, nullCellErrorMessage } = require('../utils/nullCellCheck');
const { logActivity } = require('../utils/activityLog');
const { isAdminUser, createApprovalRequest } = require('../utils/approvals');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

// The seeded default admin account (user_id "admin") is protected at the
// application layer only — it can never be deleted or deactivated through
// the app itself, so there's no way to accidentally lock everyone out of
// the system. This is intentionally NOT a database constraint: it can still
// be deleted or modified directly via a SQL query against the database.
const PROTECTED_USER_ID = 'admin';

const TEMPLATE_HEADERS = ['user_id', 'email', 'role_name', 'status'];
const TEMPLATE_EXAMPLE = ['jdoe01', 'jane.doe@example.com', 'Admin', 'ACTIVE'];

router.get('/template', requirePermission('users', 'edit'), async (req, res) => {
  const [roles] = await pool.query('SELECT role_name FROM roles ORDER BY role_name');
  const validations = [
    { column: 'role_name', values: roles.map((r) => r.role_name) },
    { column: 'status', values: ['ACTIVE', 'INACTIVE'] }
  ];
  await sendTemplate(res, 'users-template.xlsx', TEMPLATE_HEADERS, TEMPLATE_EXAMPLE, validations);
});

// ---- Approval-workflow-aware apply functions ----
// Each performs the actual database change for one action type. Called
// directly by the routes below when the actor is an Admin (immediate
// effect, unchanged from before this feature existed), and later by the
// approvals dispatcher when a non-Admin's staged request is approved.

async function applyCreateUser(body) {
  const { user_id, password, email, role_id, can_approve } = body;
  if (!user_id || !password || !role_id) { const err = new Error('User ID, password and role are required'); err.status = 400; throw err; }
  if (!email) { const err = new Error('Email is required'); err.status = 400; throw err; }
  if (!/^[a-zA-Z0-9]+$/.test(user_id)) { const err = new Error('User ID may only contain letters and numbers'); err.status = 400; throw err; }

  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    `INSERT INTO users (user_id, password_hash, email, role_id, status, can_approve) VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
    [user_id, hash, email, role_id, can_approve ? 1 : 0]
  );
  return { id: result.insertId, user_id };
}

async function applyUpdateUser(id, body) {
  const { email, role_id, password, can_approve } = body;
  if (!email) { const err = new Error('Email is required'); err.status = 400; throw err; }

  const [[existing]] = await pool.query('SELECT user_id FROM users WHERE id = ?', [id]);
  if (!existing) { const err = new Error('User not found'); err.status = 404; throw err; }

  // The protected admin account's ability to approve is permanent — never
  // settable through this form, on or off, regardless of what's submitted.
  const effectiveCanApprove = existing.user_id === PROTECTED_USER_ID ? 1 : (can_approve ? 1 : 0);
  await pool.query(`UPDATE users SET email=?, role_id=?, can_approve=? WHERE id=?`, [email, role_id, effectiveCanApprove, id]);
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
  }
  return { user_id: existing.user_id };
}

async function applyStatusChangeUser(id, status) {
  const [[user]] = await pool.query('SELECT user_id FROM users WHERE id = ?', [id]);
  if (!user) { const err = new Error('User not found'); err.status = 404; throw err; }
  if (status === 'INACTIVE' && user.user_id === PROTECTED_USER_ID) {
    const err = new Error('The default admin account cannot be deactivated.');
    err.status = 403;
    throw err;
  }
  await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  return { user_id: user.user_id };
}

async function applyDeleteUser(id) {
  const [[user]] = await pool.query('SELECT user_id FROM users WHERE id = ?', [id]);
  if (user && user.user_id === PROTECTED_USER_ID) {
    const err = new Error('The default admin account cannot be deleted.');
    err.status = 403;
    throw err;
  }
  await pool.query('DELETE FROM users WHERE id = ?', [id]);
  return { user_id: user?.user_id };
}

async function applyRoleChangeUsers(ids, roleId) {
  const [[role]] = await pool.query('SELECT id FROM roles WHERE id = ?', [roleId]);
  if (!role) { const err = new Error('Role not found'); err.status = 404; throw err; }
  const placeholders = ids.map(() => '?').join(',');
  await pool.query(`UPDATE users SET role_id = ? WHERE id IN (${placeholders})`, [roleId, ...ids]);
  return {};
}

// Shared by both bulk status-change and bulk delete: the protected admin
// account is silently skipped rather than blocking the whole batch.
async function filterOutProtectedUser(ids) {
  const placeholders = ids.map(() => '?').join(',');
  const [[protectedUser]] = await pool.query(
    `SELECT id FROM users WHERE id IN (${placeholders}) AND user_id = ?`,
    [...ids, PROTECTED_USER_ID]
  );
  if (!protectedUser) return { targetIds: ids, note: undefined };
  return {
    targetIds: ids.filter((id) => Number(id) !== protectedUser.id),
    note: 'The default admin account cannot be changed this way and was skipped.'
  };
}

async function applyBulkStatusChangeUsers(ids, status) {
  let targetIds = ids;
  let note;
  if (status === 'INACTIVE') {
    ({ targetIds, note } = await filterOutProtectedUser(ids));
  }
  if (!targetIds.length) return { count: 0, note };
  const placeholders = targetIds.map(() => '?').join(',');
  await pool.query(`UPDATE users SET status = ? WHERE id IN (${placeholders})`, [status, ...targetIds]);
  return { count: targetIds.length, note };
}

async function applyBulkDeleteUsers(ids) {
  const { targetIds, note } = await filterOutProtectedUser(ids);
  if (!targetIds.length) return { count: 0, note };
  const placeholders = targetIds.map(() => '?').join(',');
  await pool.query(`DELETE FROM users WHERE id IN (${placeholders})`, targetIds);
  return { count: targetIds.length, note };
}

// NOTE: these /bulk/* routes must stay registered before /:id below —
// otherwise Express would match "bulk" as the :id parameter of that route.
router.patch('/bulk/status', requirePermission('users', 'edit'), async (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: 'No users selected' });
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ message: 'Invalid status' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'users', action: 'BULK_STATUS_CHANGE', payload: { ids, status },
      description: `Bulk set ${ids.length} user(s) to ${status}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const result = await applyBulkStatusChangeUsers(ids, status);
  res.json({ message: `${result.count} user(s) updated`, count: result.count, ...(result.note ? { note: result.note } : {}) });
  if (result.count) await logActivity(req, 'STATUS_CHANGE', 'users', `Bulk set ${result.count} user(s) to ${status}`);
});

router.patch('/bulk/role', requirePermission('users', 'edit'), async (req, res) => {
  const { ids, role_id } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: 'No users selected' });
  if (!role_id) return res.status(400).json({ message: 'A role is required' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'users', action: 'BULK_ROLE_CHANGE', payload: { ids, role_id },
      description: `Bulk change role for ${ids.length} user(s)`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    await applyRoleChangeUsers(ids, role_id);
    res.json({ message: `${ids.length} user(s) updated`, count: ids.length });
    await logActivity(req, 'UPDATE', 'users', `Bulk changed role for ${ids.length} user(s)`);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});

router.delete('/bulk', requirePermission('users', 'delete'), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: 'No users selected' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'users', action: 'BULK_DELETE', payload: { ids },
      description: `Bulk delete ${ids.length} user(s)`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const result = await applyBulkDeleteUsers(ids);
  res.json({ message: `${result.count} user(s) deleted`, count: result.count, ...(result.note ? { note: result.note } : {}) });
  if (result.count) await logActivity(req, 'DELETE', 'users', `Bulk deleted ${result.count} user(s)`);
});

const LIST_SQL = `
  SELECT u.id, u.user_id, u.email, u.status, u.role_id, u.can_approve, r.role_name
  FROM users u JOIN roles r ON r.id = u.role_id`;

router.get('/', requirePermission('users', 'view'), async (req, res) => {
  const [rows] = await pool.query(`${LIST_SQL} ORDER BY u.user_id`);
  res.json(rows);
});

router.get('/:id', requirePermission('users', 'view'), async (req, res) => {
  const [[row]] = await pool.query(`${LIST_SQL} WHERE u.id = ?`, [req.params.id]);
  if (!row) return res.status(404).json({ message: 'User not found' });
  res.json(row);
});

router.post('/', requirePermission('users', 'edit'), async (req, res) => {
  const { user_id } = req.body;

  if (!isAdminUser(req)) {
    if (!user_id) return res.status(400).json({ message: 'User ID is required' });
    await createApprovalRequest({
      req, moduleKey: 'users', action: 'CREATE', payload: req.body,
      description: `Create user ${user_id}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    const result = await applyCreateUser(req.body);
    res.status(201).json({ id: result.id });
    await logActivity(req, 'CREATE', 'users', `Created user ${result.user_id}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'User ID already exists' });
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});

router.put('/:id', requirePermission('users', 'edit'), async (req, res) => {
  const [[existing]] = await pool.query('SELECT user_id FROM users WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'User not found' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'users', action: 'UPDATE', targetId: req.params.id, payload: req.body,
      description: `Edit user ${existing.user_id}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    const result = await applyUpdateUser(req.params.id, req.body);
    res.json({ message: 'User updated' });
    await logActivity(req, 'UPDATE', 'users', `Updated user ${result.user_id}`);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});

router.patch('/:id/status', requirePermission('users', 'edit'), async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ message: 'Invalid status' });

  const [[existing]] = await pool.query('SELECT user_id FROM users WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'User not found' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'users', action: 'STATUS_CHANGE', targetId: req.params.id, payload: { status },
      description: `Set user ${existing.user_id} to ${status}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    const result = await applyStatusChangeUser(req.params.id, status);
    res.json({ message: 'Status updated' });
    await logActivity(req, 'STATUS_CHANGE', 'users', `Set user ${result.user_id} to ${status}`);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});

// Admin-only: resets a user's password back to their own User ID and forces
// them to set a new one at next sign-in. Restricted to the Admin role
// specifically (not just anyone granted edit access to the Users module) —
// this is a more sensitive action than ordinary profile edits, and since
// it's already Admin-only, it's naturally exempt from the approval
// workflow (an Admin's actions always apply immediately).
router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  const [[user]] = await pool.query('SELECT id, user_id FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const hash = await bcrypt.hash(user.user_id, 10);
  await pool.query(
    'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?',
    [hash, req.params.id]
  );
  res.json({ message: `Password reset to the User ID (${user.user_id}). They must set a new password at next sign-in.` });
  await logActivity(req, 'PASSWORD_RESET', 'users', `Reset password for user ${user.user_id}`);
});

router.delete('/:id', requirePermission('users', 'delete'), async (req, res) => {
  const [[existing]] = await pool.query('SELECT user_id FROM users WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'User not found' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'users', action: 'DELETE', targetId: req.params.id,
      description: `Delete user ${existing.user_id}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    const result = await applyDeleteUser(req.params.id);
    res.json({ message: 'User deleted' });
    if (result.user_id) await logActivity(req, 'DELETE', 'users', `Deleted user ${result.user_id}`);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
});

// Shared by the direct-upload path (Admin, streamed) and the
// approval-triggered path (everyone else, applied later, no streaming).
async function processUserImportRows(conn, sheet, colIndex, results, reportProgress, isCancelled) {
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

    const userId = get('user_id');
    if (!userId) continue;

    try {
      if (!/^[a-zA-Z0-9]+$/.test(userId)) {
        results.errors.push(`Row ${r}: user_id "${userId}" may only contain letters and numbers`);
        results.skipped++;
        continue;
      }

      const roleName = get('role_name');
      if (!roleName) {
        results.errors.push(`Row ${r}: role_name is required`);
        results.skipped++;
        continue;
      }
      const [[role]] = await conn.query('SELECT id FROM roles WHERE role_name = ?', [roleName]);
      if (!role) {
        results.errors.push(`Row ${r}: role_name "${roleName}" not found`);
        results.skipped++;
        continue;
      }

      // Upsert by User ID: a row whose ID already exists updates that
      // account's details instead of failing as a duplicate. The
      // existing password and must_change_password flag are left
      // untouched on an update — only a brand-new account gets the
      // default password. The protected admin account can never be
      // flipped to Inactive this way.
      const statusRaw = (get('status') || 'ACTIVE').toUpperCase();
      let status = ['ACTIVE', 'INACTIVE'].includes(statusRaw) ? statusRaw : 'ACTIVE';

      const [[existing]] = await conn.query('SELECT id, user_id FROM users WHERE user_id = ?', [userId]);
      if (existing) {
        if (existing.user_id === PROTECTED_USER_ID) status = 'ACTIVE';
        await conn.query(
          `UPDATE users SET email=?, role_id=?, status=? WHERE id=?`,
          [get('email'), role.id, status, existing.id]
        );
        results.updated++;
        continue;
      }

      const passwordHash = await bcrypt.hash(userId, 10); // default password = user_id, must be changed at first login
      await conn.query(
        `INSERT INTO users (user_id, password_hash, email, role_id, status, must_change_password)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [userId, passwordHash, get('email'), role.id, status]
      );
      results.inserted++;
    } catch (err) {
      results.errors.push(`Row ${r}: ${err.message}`);
      results.skipped++;
    }
  }
}

// Runs a staged, already-validated file once its approval request is
// approved — no streaming, just a plain transaction and a final summary.
// The staged file itself is deleted by the Approvals route afterward.
async function applyImportUsers(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const header = sheet.getRow(1).values.map((v) => (v || '').toString().trim().toLowerCase());
  const colIndex = (name) => header.indexOf(name);

  const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await processUserImportRows(conn, sheet, colIndex, results, () => {}, () => false);
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
// Bulk import from Excel (see TEMPLATE_HEADERS above). password defaults to
// the user_id itself when left blank, and the account is flagged to require
// a password change on first sign-in. Every account gets full Salary Slips
// access (view and download) — that isn't configurable through this page.
// ---------------------------------------------------------------
router.post(
  '/import',
  requirePermission('users', 'edit'),
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
    // nullCellCheck.js for the exact rule. status is optional and falls
    // back to ACTIVE when left blank; salary_slip_access is no longer a
    // column at all, since every account always gets full access.
    const REQUIRED_COLUMNS = ['user_id', 'email', 'role_name'];
    const nullProblems = findNullCellProblems(sheet, colIndex, REQUIRED_COLUMNS);
    if (nullProblems.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: nullCellErrorMessage(nullProblems) });
    }

    // Non-Admin: the file already passed the same validation an Admin's
    // upload would — stage it for approval instead of importing it now.
    if (!isAdminUser(req)) {
      const rowCount = Math.max(0, sheet.rowCount - 1);
      await createApprovalRequest({
        req, moduleKey: 'users', action: 'IMPORT', stagedFilePath: req.file.path,
        description: `Bulk import ${rowCount} user row(s)`
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

      await processUserImportRows(conn, sheet, colIndex, results, reportProgress, () => cancelled);

      if (cancelled) {
        await conn.rollback();
      } else {
        await conn.commit();
        sendDone(results);
        await logActivity(req, 'IMPORT', 'users', `Imported users: ${results.inserted} new, ${results.updated} updated, ${results.skipped} skipped`);
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
// for this module.
async function applyApprovedUserAction(action, targetId, payload, requestedBy, stagedFilePath) {
  switch (action) {
    case 'CREATE':
      return applyCreateUser(payload);
    case 'UPDATE':
      return applyUpdateUser(targetId, payload);
    case 'STATUS_CHANGE':
      return applyStatusChangeUser(targetId, payload.status);
    case 'BULK_STATUS_CHANGE':
      return applyBulkStatusChangeUsers(payload.ids, payload.status);
    case 'BULK_ROLE_CHANGE':
      return applyRoleChangeUsers(payload.ids, payload.role_id);
    case 'DELETE':
      return applyDeleteUser(targetId);
    case 'BULK_DELETE':
      return applyBulkDeleteUsers(payload.ids);
    case 'IMPORT':
      return applyImportUsers(stagedFilePath);
    default:
      throw new Error(`Unknown action "${action}" for users`);
  }
}

module.exports = router;
module.exports.applyApprovedAction = applyApprovedUserAction;
