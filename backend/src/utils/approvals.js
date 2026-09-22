const pool = require('../config/db');
const fs = require('fs');
const { resolveApprovers } = require('./approvalRouting');

const EXPIRY_DAYS = 7;

function isAdminUser(req) {
  return req.user.source === 'user' && req.user.roleName === 'Admin';
}

// Stages a non-Admin's action for approval instead of applying it. Creates
// the approval_requests row (expiring in 7 days) and an in-app notification
// for whoever can actually see it. In-app only, by design — no email is
// sent for this workflow.
//
// Every request always resolves to a specific set of approvers — never
// "every Admin" — decided once, right here, at creation time: whichever
// approvers a matching routing rule names (or the Super Admin alone, if no
// rule matches, or if one matches but none of its named approvers are
// currently eligible). A later edit to the routing rules never changes who
// can see a request already sitting pending — it keeps whatever
// visibility it started with.
async function createApprovalRequest({ req, moduleKey, action, targetId = null, payload = null, stagedFilePath = null, description }) {
  const approverIds = await resolveApprovers(moduleKey, action);

  const [result] = await pool.query(
    `INSERT INTO approval_requests
      (module_key, action, requested_by, requested_by_name, requested_by_email, target_id, payload, staged_file_path, description, expires_at, visible_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${EXPIRY_DAYS} DAY), ?)`,
    [moduleKey, action, req.user.id, req.user.userId, req.user.email || null, targetId,
     payload ? JSON.stringify(payload) : null, stagedFilePath, description, JSON.stringify(approverIds)]
  );
  const approvalId = result.insertId;

  let recipients = [];
  if (approverIds.length) {
    const placeholders = approverIds.map(() => '?').join(',');
    const [rows] = await pool.query(`SELECT id, user_id, email FROM users WHERE id IN (${placeholders})`, approverIds);
    recipients = rows;
  }

  const message = `${req.user.userId} requested: ${description}`;
  for (const recipient of recipients) {
    await pool.query('INSERT INTO notifications (user_id, approval_id, message) VALUES (?, ?, ?)', [recipient.id, approvalId, message]);
  }
  return approvalId;
}

// Notifies the original requester in-app once their request has been
// decided (or has expired).
async function notifyRequester(request, status, reason = null) {
  if (!request.requested_by) return; // account since deleted — nothing to notify
  let message;
  if (status === 'APPROVED') message = `Your request "${request.description}" was approved and has been applied.`;
  else if (status === 'REJECTED') message = `Your request "${request.description}" was rejected. Reason: ${reason}`;
  else message = `Your request "${request.description}" expired after ${EXPIRY_DAYS} days without a decision.`;

  await pool.query('INSERT INTO notifications (user_id, approval_id, message) VALUES (?, ?, ?)', [request.requested_by, request.id, message]);
}

// Run daily by the same cron schedule as the retention cleanup. Anything
// still PENDING past its expires_at is marked EXPIRED, its staged import
// file (if any) is deleted, and the original requester is notified.
async function expireStaleApprovalRequests() {
  const [rows] = await pool.query(
    `SELECT * FROM approval_requests WHERE status = 'PENDING' AND expires_at < NOW()`
  );
  for (const request of rows) {
    await pool.query(`UPDATE approval_requests SET status = 'EXPIRED' WHERE id = ?`, [request.id]);
    if (request.staged_file_path) fs.unlink(request.staged_file_path, () => {});
    await notifyRequester(request, 'EXPIRED');
  }
  if (rows.length) console.log(`Approval workflow: expired ${rows.length} stale request(s).`);
  return rows.length;
}

module.exports = { isAdminUser, createApprovalRequest, notifyRequester, expireStaleApprovalRequests };
