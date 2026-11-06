const pool = require('../config/db');

const PROTECTED_USER_ID = 'admin'; // matches routes/users.js's PROTECTED_USER_ID

// Fetches the one protected Super Admin account — the guaranteed fallback
// approver when a routed request's assigned approvers all become
// ineligible, and the sole approver for anything in the Users module.
async function getSuperAdmin() {
  const [[row]] = await pool.query(`SELECT id, user_id, email FROM users WHERE user_id = ?`, [PROTECTED_USER_ID]);
  return row || null;
}

const cleanIds = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

// True if this specific account can act as the approver of a request right
// now. Checked live rather than trusted from when a rule was created, since
// status, role, access and the "Can approve" flag can all change later.
//   - an active account with "Can approve" turned on - any role, not only Admin
//   - never the person who made the request
//   - for a request about particular establishments: an account that has access
//     to every one of them (an Admin / "all establishments" account has all)
//   - a Users-module request is only ever approved by an Admin-role account
//     (it can change roles and access, so it is not handed to anyone else)
// ctx = { establishmentIds, requestedBy, moduleKey }
async function isEligibleApprover(userId, ctx = {}) {
  if (ctx.requestedBy && Number(userId) === Number(ctx.requestedBy)) return false;
  const [[user]] = await pool.query(
    `SELECT u.id, u.all_establishments, r.role_name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.status = 'ACTIVE' AND u.can_approve = 1`,
    [userId]
  );
  if (!user) return false;
  if (ctx.moduleKey === 'users' && user.role_name !== 'Admin') return false;
  const needed = cleanIds(ctx.establishmentIds);
  if (!needed.length) return true;
  if (user.all_establishments) return true;
  const [rows] = await pool.query('SELECT establishment_id FROM user_establishments WHERE user_id = ?', [userId]);
  // An Admin-role account sees all data, but its approval requests can be
  // limited to chosen establishments; with none chosen it covers all of them.
  if (user.role_name === 'Admin' && !rows.length) return true;
  const have = new Set(rows.map((r) => Number(r.establishment_id)));
  return needed.every((id) => have.has(id));
}

// Finds the best-matching routing rule for a given module/action, if any.
// Priority: a rule naming this exact module always outranks one that only
// names this action across any module — module beats action, as decided —
// and an exact module+action match outranks a module-only one.
// A "many records at once" action follows the rule of its single-record
// version: a rule for "Delete" also covers "Bulk Delete" and "Delete Selected
// Records", "Edit" covers "Bulk Edit" and "Bulk Role Change", "Status Change"
// covers "Bulk Status Change", and an Excel import follows a "Create" rule
// (or, failing that, an "Edit" rule). A rule that names the exact action
// itself (older rules may) still wins.
const ACTION_FAMILY = {
  BULK_DELETE_RECORDS: ['DELETE'],
  ARREAR_CREATE: ['CREATE'],
  ARREAR_UPDATE: ['UPDATE'],
  ARREAR_DELETE: ['DELETE'],
  ARREAR_IMPORT: ['CREATE', 'UPDATE'],
  BULK_DELETE: ['DELETE'],
  BULK_UPDATE: ['UPDATE'],
  BULK_ROLE_CHANGE: ['UPDATE'],
  BULK_STATUS_CHANGE: ['STATUS_CHANGE'],
  APP_ACCESS: ['UPDATE'],
  BULK_APP_ACCESS: ['UPDATE'],
  IMPORT: ['CREATE', 'UPDATE']
};

// Every rule that applies, grouped by how well it matches (best group first).
// Rules that match equally well belong to the same group and ALL of them count -
// two "Create" rules naming two different people send the request to both.
async function findMatchingRuleGroups(moduleKey, action) {
  const family = ACTION_FAMILY[action] || [];
  const names = [action, ...family];
  const [rules] = await pool.query(
    `SELECT id, module_key, action, approver_ids FROM approval_routing_rules
     WHERE (module_key = ? OR module_key IS NULL) AND (action IN (?) OR action IS NULL)`,
    [moduleKey, names]
  );
  if (!rules.length) return [];
  // Exact action first, then its family in order, then "any action".
  const actionScore = (r) => (r.action === action ? 5 : r.action ? 4 - names.indexOf(r.action) * 0.5 : 0);
  const score = (r) => (r.module_key ? 10 : 0) + actionScore(r);
  const groups = new Map();
  for (const r of rules) {
    const key = score(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, list]) => list);
}

const approverIdsOf = (rule) => (typeof rule.approver_ids === 'string' ? JSON.parse(rule.approver_ids) : rule.approver_ids) || [];

// Determines which specific accounts a brand-new approval request should
// be restricted to. Always resolves to a concrete list - never "every
// Admin" - so every request has a well-defined, specific owner:
//   - the approvers named by the best-matching rule(s) who are eligible for
//     THIS request (see isEligibleApprover - including having access to the
//     request's establishment(s));
//   - if none of them is eligible, the next-best matching rule is tried;
//   - the Super Admin alone, if no rule matches at all or nobody is eligible.
// ctx = { establishmentIds, requestedBy }
async function resolveApprovers(moduleKey, action, ctx = {}) {
  const superAdmin = await getSuperAdmin();
  const superAdminFallback = superAdmin ? [superAdmin.id] : [];
  const check = { ...ctx, moduleKey };

  const groups = await findMatchingRuleGroups(moduleKey, action);
  for (const group of groups) {
    const candidates = [...new Set(group.flatMap(approverIdsOf))];
    const eligible = [];
    for (const userId of candidates) {
      if (await isEligibleApprover(userId, check)) eligible.push(userId);
    }
    if (eligible.length) return eligible;
  }
  return superAdminFallback;
}

// For an already-created, restricted-visibility request, re-checks
// eligibility live — someone eligible when the request was made might not
// be anymore by the time it's actually viewed. Returns the current
// effective list of user ids who can see/act on it: whichever originally
// assigned approvers are still eligible, or the Super Admin alone if none
// of them are.
async function currentEffectiveApprovers(assignedUserIds, ctx = {}) {
  const eligible = [];
  for (const userId of assignedUserIds) {
    if (await isEligibleApprover(userId, ctx)) eligible.push(userId);
  }
  if (eligible.length) return eligible;
  const superAdmin = await getSuperAdmin();
  return superAdmin ? [superAdmin.id] : [];
}

module.exports = { getSuperAdmin, isEligibleApprover, resolveApprovers, currentEffectiveApprovers, PROTECTED_USER_ID };
