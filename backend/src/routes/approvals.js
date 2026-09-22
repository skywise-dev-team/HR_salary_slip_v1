const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const fs = require('fs');
const pool = require('../config/db');
const { requireAuth, requireAdmin, requireNotPendingPasswordChange } = require('../middleware/auth');
const { notifyRequester } = require('../utils/approvals');
const { currentEffectiveApprovers, PROTECTED_USER_ID } = require('../utils/approvalRouting');
const { logActivity } = require('../utils/activityLog');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);
// Every route in this file is Admin-only — this is intentionally NOT a
// togglable permission like other modules in Roles & Permissions, so there
// is no way to accidentally grant a non-admin role access to approve or
// reject anything.
router.use(requireAdmin);

// Required lazily (inside the function, not at file-load time) so this
// file can be loaded by server.js in any order relative to the module
// route files it dispatches into.
function getModuleRouter(moduleKey) {
  switch (moduleKey) {
    case 'employees': return require('./employees');
    case 'users': return require('./users');
    case 'upload_salary': return require('./salaryData');
    default: throw new Error(`Unknown module_key "${moduleKey}"`);
  }
}

// True if req.user is allowed to see/act on a request whose visible_to
// value (from the approval_requests row itself — a MySQL JSON column,
// already auto-deserialized into a real array or null by mysql2, never a
// string needing JSON.parse) is as given. null means unrestricted — no
// routing rule matched when it was created, so every Admin can see it,
// today's default. Otherwise, the current user must be among its
// currently-effective approvers: its originally assigned approvers,
// re-checked live (someone eligible back then might not be anymore), or
// the Super Admin alone if none of them are eligible now.
async function isVisibleTo(req, visibleTo) {
  // The Super Admin is a permanent overseer of everything, on top of being
  // the fallback owner for anything unrouted — this is the one deliberate
  // exception to "fully hidden from every other Admin", by design.
  if (req.user.userId === PROTECTED_USER_ID) return true;
  if (visibleTo === null) return true;
  const effective = await currentEffectiveApprovers(visibleTo);
  return effective.includes(req.user.id);
}

router.get('/', async (req, res) => {
  const status = req.query.status || 'PENDING';
  const [rows] = await pool.query(
    `SELECT id, module_key, action, requested_by_name, target_id, description, status,
            rejection_reason, decided_by_name, decided_at, created_at, expires_at, visible_to,
            (staged_file_path IS NOT NULL) AS has_file
     FROM approval_requests WHERE status = ? ORDER BY created_at DESC`,
    [status]
  );
  const visible = [];
  for (const row of rows) {
    if (await isVisibleTo(req, row.visible_to)) {
      delete row.visible_to; // internal routing detail, not part of the public shape
      visible.push(row);
    }
  }
  res.json(visible);
});

router.get('/count', async (req, res) => {
  const [rows] = await pool.query(`SELECT visible_to FROM approval_requests WHERE status = 'PENDING'`);
  let count = 0;
  for (const row of rows) {
    if (await isVisibleTo(req, row.visible_to)) count++;
  }
  res.json({ count });
});

router.get('/:id', async (req, res) => {
  const [[request]] = await pool.query('SELECT * FROM approval_requests WHERE id = ?', [req.params.id]);
  // A request this Admin isn't allowed to see reports as not found, the
  // same as one that genuinely doesn't exist — "fully hidden" means no
  // acknowledgment it exists at all, not just that its details are blocked.
  if (!request || !(await isVisibleTo(req, request.visible_to))) return res.status(404).json({ message: 'Request not found' });
  delete request.visible_to;
  res.json(request);
});

// Only relevant for a bulk-import request once that's staged this way —
// lets the Admin download the exact file that was uploaded to review it
// before deciding.
router.get('/:id/file', async (req, res) => {
  const [[request]] = await pool.query('SELECT staged_file_path, visible_to FROM approval_requests WHERE id = ?', [req.params.id]);
  if (!request || !(await isVisibleTo(req, request.visible_to)) || !request.staged_file_path || !fs.existsSync(request.staged_file_path)) {
    return res.status(404).json({ message: 'No file available for this request' });
  }
  res.download(request.staged_file_path);
});

router.post('/:id/approve', async (req, res) => {
  const [[request]] = await pool.query('SELECT * FROM approval_requests WHERE id = ?', [req.params.id]);
  if (!request || !(await isVisibleTo(req, request.visible_to))) return res.status(404).json({ message: 'Request not found' });
  if (request.status !== 'PENDING') return res.status(409).json({ message: `This request is already ${request.status.toLowerCase()}.` });

  try {
    const moduleRouter = getModuleRouter(request.module_key);
    // request.payload comes back from a MySQL JSON-typed column — mysql2
    // auto-deserializes that into a real object already, not a string, so
    // JSON.parse() would (and did) fail here. Only parse it if it's
    // actually still a string.
    const payload = typeof request.payload === 'string' ? JSON.parse(request.payload) : request.payload;
    await moduleRouter.applyApprovedAction(request.action, request.target_id, payload, request.requested_by, request.staged_file_path);
  } catch (err) {
    // Left PENDING on failure — the Admin can see what went wrong and
    // retry after the underlying issue is fixed, rather than the request
    // being silently lost.
    return res.status(400).json({ message: `Could not apply this request: ${err.message}` });
  }

  await pool.query(
    `UPDATE approval_requests SET status = 'APPROVED', decided_by = ?, decided_by_name = ?, decided_at = NOW() WHERE id = ?`,
    [req.user.id, req.user.userId, request.id]
  );
  if (request.staged_file_path) fs.unlink(request.staged_file_path, () => {});

  await notifyRequester(request, 'APPROVED');
  await logActivity(req, 'UPDATE', request.module_key, `Approved: ${request.description} (requested by ${request.requested_by_name})`);
  res.json({ message: 'Approved and applied.' });
});

router.post('/:id/reject', async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ message: 'A reason is required to reject a request.' });

  const [[request]] = await pool.query('SELECT * FROM approval_requests WHERE id = ?', [req.params.id]);
  if (!request || !(await isVisibleTo(req, request.visible_to))) return res.status(404).json({ message: 'Request not found' });
  if (request.status !== 'PENDING') return res.status(409).json({ message: `This request is already ${request.status.toLowerCase()}.` });

  await pool.query(
    `UPDATE approval_requests SET status = 'REJECTED', rejection_reason = ?, decided_by = ?, decided_by_name = ?, decided_at = NOW() WHERE id = ?`,
    [reason.trim(), req.user.id, req.user.userId, request.id]
  );
  if (request.staged_file_path) fs.unlink(request.staged_file_path, () => {});

  await notifyRequester(request, 'REJECTED', reason.trim());
  await logActivity(req, 'UPDATE', request.module_key, `Rejected: ${request.description} (requested by ${request.requested_by_name}) — ${reason.trim()}`);
  res.json({ message: 'Rejected.' });
});

module.exports = router;
