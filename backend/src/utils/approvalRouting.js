const pool = require('../config/db');

const PROTECTED_USER_ID = 'admin'; // matches routes/users.js's PROTECTED_USER_ID

// Fetches the one protected Super Admin account — the guaranteed fallback
// approver when a routed request's assigned approvers all become
// ineligible, and the sole approver for anything in the Users module.
async function getSuperAdmin() {
  const [[row]] = await pool.query(`SELECT id, user_id, email FROM users WHERE user_id = ?`, [PROTECTED_USER_ID]);
  return row || null;
}

// True if this specific account is currently eligible to act as an
// approver at all: an active Admin with "Can approve" turned on. Checked
// live rather than trusted from when a rule was created, since status,
// role, and this flag can all change after the fact.
async function isEligibleApprover(userId) {
  const [[row]] = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.status = 'ACTIVE' AND u.can_approve = 1 AND r.role_name = 'Admin'`,
    [userId]
  );
  return !!row;
}

// Finds the best-matching routing rule for a given module/action, if any.
// Priority: a rule naming this exact module always outranks one that only
// names this action across any module — module beats action, as decided —
// and an exact module+action match outranks a module-only one.
async function findMatchingRule(moduleKey, action) {
  const [rules] = await pool.query(
    `SELECT id, module_key, action, approver_ids FROM approval_routing_rules
     WHERE (module_key = ? OR module_key IS NULL) AND (action = ? OR action IS NULL)`,
    [moduleKey, action]
  );
  if (!rules.length) return null;
  const score = (r) => (r.module_key ? 2 : 0) + (r.action ? 1 : 0);
  rules.sort((a, b) => score(b) - score(a));
  return rules[0];
}

// Determines which specific accounts a brand-new approval request should
// be restricted to. Always resolves to a concrete list — never "every
// Admin" — so every request has a well-defined, specific owner:
//   - the rule's currently-eligible approvers, if one matches
//   - the Super Admin alone, if no rule matches at all, or if one matches
//     but every one of its named approvers has since become ineligible
//
// Users -> any action is a hard-coded, permanent exception: always Super
// Admin only, regardless of any configured rule, and this can never be
// reassigned through the routing rules screen.
async function resolveApprovers(moduleKey, action) {
  const superAdmin = await getSuperAdmin();
  const superAdminFallback = superAdmin ? [superAdmin.id] : [];

  if (moduleKey === 'users') {
    return superAdminFallback;
  }

  const rule = await findMatchingRule(moduleKey, action);
  if (!rule) return superAdminFallback;

  // approver_ids comes back from a MySQL JSON-typed column — mysql2
  // auto-deserializes that into a real array already, not a string
  // needing JSON.parse (the exact same gotcha as the payload column
  // elsewhere in this feature).
  const eligible = [];
  for (const userId of rule.approver_ids) {
    if (await isEligibleApprover(userId)) eligible.push(userId);
  }
  if (eligible.length) return eligible;

  // Every named approver on this rule is currently ineligible — fall back
  // to the Super Admin rather than leaving the request unreachable by
  // anyone at all.
  return superAdminFallback;
}

// For an already-created, restricted-visibility request, re-checks
// eligibility live — someone eligible when the request was made might not
// be anymore by the time it's actually viewed. Returns the current
// effective list of user ids who can see/act on it: whichever originally
// assigned approvers are still eligible, or the Super Admin alone if none
// of them are.
async function currentEffectiveApprovers(assignedUserIds) {
  const eligible = [];
  for (const userId of assignedUserIds) {
    if (await isEligibleApprover(userId)) eligible.push(userId);
  }
  if (eligible.length) return eligible;
  const superAdmin = await getSuperAdmin();
  return superAdmin ? [superAdmin.id] : [];
}

module.exports = { getSuperAdmin, isEligibleApprover, resolveApprovers, currentEffectiveApprovers, PROTECTED_USER_ID };
