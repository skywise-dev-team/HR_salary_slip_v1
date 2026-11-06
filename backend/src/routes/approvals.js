const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const fs = require('fs');
const pool = require('../config/db');
const { requireAuth, requireApprover, requireNotPendingPasswordChange } = require('../middleware/auth');
const { notifyRequester } = require('../utils/approvals');
const { currentEffectiveApprovers, PROTECTED_USER_ID } = require('../utils/approvalRouting');
const { buildChangeDetails } = require('../utils/approvalDetails');
const { logActivity } = require('../utils/activityLog');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);
// Every route in this file is for accounts with "Can approve" turned on (set
// per user on the Users page, any role). This is intentionally NOT a togglable
// module permission in Roles & Permissions. What an approver actually sees is
// limited per request - see isVisibleTo below.
router.use(requireApprover);

const BULK_DECISION_MAX = 200;

// Requests that carry a list of record ids can be decided for only some of
// those records: the approver ticks the ones to approve (or reject) and the
// rest stay pending in the same request.
const SPLITTABLE = {
  employees: ['BULK_STATUS_CHANGE', 'BULK_APP_ACCESS', 'BULK_DELETE'],
  users: ['BULK_STATUS_CHANGE', 'BULK_ROLE_CHANGE', 'BULK_DELETE'],
  upload_salary: ['BULK_UPDATE', 'BULK_DELETE_RECORDS']
};
const asObject = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
function splitIds(request) {
  if (!(SPLITTABLE[request.module_key] || []).includes(request.action)) return null;
  const p = asObject(request.payload);
  return p && Array.isArray(p.ids) && p.ids.length > 1 ? p.ids.map(Number) : null;
}

// Required lazily (inside the function, not at file-load time) so this
// file can be loaded by server.js in any order relative to the module
// route files it dispatches into.
function getModuleRouter(moduleKey) {
  switch (moduleKey) {
    case 'employees': return require('./employees');
    case 'users': return require('./users');
    case 'upload_salary': return require('./salaryData');
    case 'establishments': return require('./establishments');
    default: throw new Error(`Unknown module_key "${moduleKey}"`);
  }
}

// True if req.user is allowed to see/act on this request row (needs the row's
// visible_to, establishment_ids and requested_by columns). visible_to is a
// MySQL JSON column, already auto-deserialized into an array or null by mysql2.
// null means an old request from before routing existed: any approver sees it.
// Otherwise the current user must be among the currently-effective approvers:
// the originally assigned ones, re-checked live (still allowed to approve, and
// still with access to the request's establishment(s)), or the Super Admin
// alone if none of them is eligible now.
async function isVisibleTo(req, row) {
  // The Super Admin is a permanent overseer of everything, on top of being
  // the fallback owner for anything unrouted.
  if (req.user.userId === PROTECTED_USER_ID) return true;
  if (row.visible_to === null || row.visible_to === undefined) return true;
  const visibleTo = typeof row.visible_to === 'string' ? JSON.parse(row.visible_to) : row.visible_to;
  const establishmentIds = typeof row.establishment_ids === 'string' ? JSON.parse(row.establishment_ids) : row.establishment_ids;
  const effective = await currentEffectiveApprovers(visibleTo, {
    establishmentIds, requestedBy: row.requested_by, moduleKey: row.module_key
  });
  return effective.includes(req.user.id);
}

router.get('/', async (req, res) => {
  const status = req.query.status || 'PENDING';
  const [rows] = await pool.query(
    `SELECT id, module_key, action, requested_by_name, target_id, description, request_reason, status,
            rejection_reason, decided_by_name, decided_at, created_at, expires_at, visible_to,
            establishment_ids, requested_by,
            (staged_file_path IS NOT NULL) AS has_file
     FROM approval_requests WHERE status = ? ORDER BY created_at DESC`,
    [status]
  );
  const visible = [];
  for (const row of rows) {
    if (await isVisibleTo(req, row)) {
      // internal routing details, not part of the public shape
      delete row.visible_to;
      delete row.establishment_ids;
      delete row.requested_by;
      visible.push(row);
    }
  }
  res.json(visible);
});

router.get('/count', async (req, res) => {
  const [rows] = await pool.query(`SELECT visible_to, establishment_ids, requested_by, module_key FROM approval_requests WHERE status = 'PENDING'`);
  let count = 0;
  for (const row of rows) {
    if (await isVisibleTo(req, row)) count++;
  }
  res.json({ count });
});

router.get('/:id', async (req, res) => {
  const [[request]] = await pool.query('SELECT * FROM approval_requests WHERE id = ?', [req.params.id]);
  // A request this Admin isn't allowed to see reports as not found, the
  // same as one that genuinely doesn't exist — "fully hidden" means no
  // acknowledgment it exists at all, not just that its details are blocked.
  if (!request || !(await isVisibleTo(req, request))) return res.status(404).json({ message: 'Request not found' });
  delete request.visible_to;
  delete request.establishment_ids;
  // The file's location on the server is not for the browser - only whether there is one.
  request.has_file = !!request.staged_file_path;
  delete request.staged_file_path;

  // While still pending, the "what will change" view is rebuilt live so its
  // "current" column is what the data looks like right now. Once decided
  // (or if it cannot be rebuilt), the view saved when the request was made
  // is used. A request made before this view existed is built on the spot.
  let details = request.change_details;
  if (request.status === 'PENDING' || !details) {
    const live = await buildChangeDetails(request.module_key, request.action, request.target_id, request.payload);
    if (live) details = live;
  }
  request.change_details = details || null;
  request.splittable = request.status === 'PENDING' && !!splitIds(request);
  res.json(request);
});

// Only relevant for a bulk-import request once that's staged this way —
// lets the Admin download the exact file that was uploaded to review it
// before deciding.
router.get('/:id/file', async (req, res) => {
  const [[request]] = await pool.query('SELECT staged_file_path, visible_to, establishment_ids, requested_by, module_key FROM approval_requests WHERE id = ?', [req.params.id]);
  if (!request || !(await isVisibleTo(req, request)) || !request.staged_file_path || !fs.existsSync(request.staged_file_path)) {
    return res.status(404).json({ message: 'No file available for this request' });
  }
  res.download(request.staged_file_path);
});

// ---- Deciding ---------------------------------------------------------
// One request at a time. Used by the single approve/reject routes and,
// one after the other, by the bulk routes below. Never throws for a
// request-level problem - returns { ok, status, message } instead so a bulk
// decision can report each request's own outcome.
async function approveOne(req, id) {
  const [[request]] = await pool.query('SELECT * FROM approval_requests WHERE id = ?', [id]);
  if (!request || !(await isVisibleTo(req, request))) return { ok: false, status: 404, message: 'Request not found' };
  if (request.status !== 'PENDING') return { ok: false, status: 409, message: `This request is already ${request.status.toLowerCase()}.` };

  try {
    const moduleRouter = getModuleRouter(request.module_key);
    // request.payload comes back from a MySQL JSON-typed column — mysql2
    // auto-deserializes that into a real object already, not a string, so
    // JSON.parse() would (and did) fail here. Only parse it if it's
    // actually still a string.
    const payload = typeof request.payload === 'string' ? JSON.parse(request.payload) : request.payload;
    await moduleRouter.applyApprovedAction(request.action, request.target_id, payload, request.requested_by, request.staged_file_path, req.user);
  } catch (err) {
    // Left PENDING on failure — the Admin can see what went wrong and
    // retry after the underlying issue is fixed, rather than the request
    // being silently lost.
    return { ok: false, status: 400, message: `Could not apply this request: ${err.message}` };
  }

  await pool.query(
    `UPDATE approval_requests SET status = 'APPROVED', decided_by = ?, decided_by_name = ?, decided_at = NOW() WHERE id = ?`,
    [req.user.id, req.user.userId, request.id]
  );
  if (request.staged_file_path) fs.unlink(request.staged_file_path, () => {});

  await notifyRequester(request, 'APPROVED');
  await logActivity(req, 'UPDATE', request.module_key, `Approved: ${request.description} (requested by ${request.requested_by_name})`);
  return { ok: true, status: 200, message: 'Approved and applied.' };
}

async function rejectOne(req, id, reason) {
  const [[request]] = await pool.query('SELECT * FROM approval_requests WHERE id = ?', [id]);
  if (!request || !(await isVisibleTo(req, request))) return { ok: false, status: 404, message: 'Request not found' };
  if (request.status !== 'PENDING') return { ok: false, status: 409, message: `This request is already ${request.status.toLowerCase()}.` };

  await pool.query(
    `UPDATE approval_requests SET status = 'REJECTED', rejection_reason = ?, decided_by = ?, decided_by_name = ?, decided_at = NOW() WHERE id = ?`,
    [reason, req.user.id, req.user.userId, request.id]
  );
  if (request.staged_file_path) fs.unlink(request.staged_file_path, () => {});

  await notifyRequester(request, 'REJECTED', reason);
  await logActivity(req, 'UPDATE', request.module_key, `Rejected: ${request.description} (requested by ${request.requested_by_name}) — ${reason}`);
  return { ok: true, status: 200, message: 'Rejected.' };
}

function cleanIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

function summarize(verb, results) {
  const done = results.filter((r) => r.ok).length;
  const failed = results.length - done;
  return failed ? `${done} ${verb}, ${failed} could not be ${verb === 'approved' ? 'applied' : 'rejected'}.` : `${done} ${verb}.`;
}

// Several requests at once. Processed one after the other, in the order
// given, never in parallel - an approved request may change data the next
// one depends on.
router.post('/bulk-approve', async (req, res) => {
  const ids = cleanIds(req.body.ids);
  if (!ids.length) return res.status(400).json({ message: 'No requests selected.' });
  if (ids.length > BULK_DECISION_MAX) return res.status(400).json({ message: `Too many requests selected (limit ${BULK_DECISION_MAX}).` });
  const results = [];
  for (const id of ids) results.push({ id, ...(await approveOne(req, id)) });
  res.json({ message: summarize('approved', results), results });
});

router.post('/bulk-reject', async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'A reason is required to reject requests.' });
  const ids = cleanIds(req.body.ids);
  if (!ids.length) return res.status(400).json({ message: 'No requests selected.' });
  if (ids.length > BULK_DECISION_MAX) return res.status(400).json({ message: `Too many requests selected (limit ${BULK_DECISION_MAX}).` });
  const results = [];
  for (const id of ids) results.push({ id, ...(await rejectOne(req, id, reason)) });
  res.json({ message: summarize('rejected', results), results });
});

// Approve or reject only some of the records inside one request. The chosen
// records are decided now and kept as their own entry in the history; the
// others stay pending in the original request.
async function decideSome(req, id, decision, pickedRaw, reason) {
  const [[request]] = await pool.query('SELECT * FROM approval_requests WHERE id = ?', [id]);
  if (!request || !(await isVisibleTo(req, request))) return { status: 404, message: 'Request not found' };
  if (request.status !== 'PENDING') return { status: 409, message: `This request is already ${request.status.toLowerCase()}.` };
  const all = splitIds(request);
  if (!all) return { status: 400, message: 'This request cannot be decided in parts.' };

  const picked = cleanIds(pickedRaw).filter((n) => all.includes(n));
  if (!picked.length) return { status: 400, message: 'No records selected.' };
  // Everything selected = an ordinary decision on the whole request.
  if (picked.length === all.length) {
    const r = decision === 'approve' ? await approveOne(req, id) : await rejectOne(req, id, reason);
    return { ...r, remaining: 0 };
  }

  const payload = asObject(request.payload);
  const remainingIds = all.filter((n) => !picked.includes(n));
  const pickedPayload = { ...payload, ids: picked };
  const restPayload = { ...payload, ids: remainingIds };
  const base = request.description.replace(/\s*\(\d+ remaining\)$/, '');
  const verb = decision === 'approve' ? 'approved' : 'rejected';
  const doneDescription = `${base} - ${picked.length} record(s) ${verb}`.slice(0, 255);
  const restDescription = `${base} (${remainingIds.length} remaining)`.slice(0, 255);

  // Written down before anything is applied, because applying (a delete, say)
  // changes what the records look like.
  const pickedDetails = await buildChangeDetails(request.module_key, request.action, request.target_id, pickedPayload);

  if (decision === 'approve') {
    try {
      await getModuleRouter(request.module_key).applyApprovedAction(request.action, request.target_id, pickedPayload, request.requested_by, null, req.user);
    } catch (err) {
      return { status: 400, message: `Could not apply the selected records: ${err.message}` };
    }
  }

  const [ins] = await pool.query(
    `INSERT INTO approval_requests
       (module_key, action, requested_by, requested_by_name, requested_by_email, target_id, payload, description,
        status, rejection_reason, decided_by, decided_by_name, decided_at, created_at, expires_at, visible_to, request_reason, change_details, establishment_ids)
     SELECT module_key, action, requested_by, requested_by_name, requested_by_email, target_id, ?, ?,
            ?, ?, ?, ?, NOW(), created_at, expires_at, visible_to, request_reason, ?, establishment_ids
     FROM approval_requests WHERE id = ?`,
    [JSON.stringify(pickedPayload), doneDescription, decision === 'approve' ? 'APPROVED' : 'REJECTED',
     decision === 'approve' ? null : reason, req.user.id, req.user.userId, pickedDetails ? JSON.stringify(pickedDetails) : null, request.id]
  );

  const restDetails = await buildChangeDetails(request.module_key, request.action, request.target_id, restPayload);
  await pool.query(
    'UPDATE approval_requests SET payload = ?, description = ?, change_details = ? WHERE id = ?',
    [JSON.stringify(restPayload), restDescription, restDetails ? JSON.stringify(restDetails) : null, request.id]
  );

  await notifyRequester({ ...request, id: ins.insertId, description: doneDescription }, decision === 'approve' ? 'APPROVED' : 'REJECTED', reason);
  await logActivity(req, 'UPDATE', request.module_key,
    `${decision === 'approve' ? 'Approved' : 'Rejected'} ${picked.length} of ${all.length} record(s): ${base} (requested by ${request.requested_by_name})${decision === 'approve' ? '' : ` - ${reason}`}`);
  return { ok: true, status: 200, message: `${picked.length} record(s) ${verb}. ${remainingIds.length} still pending.`, remaining: remainingIds.length };
}

router.post('/:id/decide-some', async (req, res) => {
  const decision = req.body.decision;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ message: 'Decision must be approve or reject.' });
  const reason = String(req.body.reason || '').trim();
  if (decision === 'reject' && !reason) return res.status(400).json({ message: 'A reason is required to reject.' });
  const r = await decideSome(req, req.params.id, decision, req.body.ids, reason);
  if (r.ok === false || (r.status && r.status >= 400)) return res.status(r.status).json({ message: r.message });
  res.json({ message: r.message, remaining: r.remaining });
});

router.post('/:id/approve', async (req, res) => {
  const result = await approveOne(req, req.params.id);
  if (!result.ok) return res.status(result.status).json({ message: result.message });
  res.json({ message: result.message });
});

router.post('/:id/reject', async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'A reason is required to reject a request.' });
  const result = await rejectOne(req, req.params.id, reason);
  if (!result.ok) return res.status(result.status).json({ message: result.message });
  res.json({ message: result.message });
});

module.exports = router;
