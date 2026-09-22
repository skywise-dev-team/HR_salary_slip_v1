const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requireAdmin, requireNotPendingPasswordChange } = require('../middleware/auth');
const { PROTECTED_USER_ID } = require('../utils/approvalRouting');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);
router.use(requireAdmin);

// Deliberately stricter than the rest of this file's Admin-only gate: only
// the one protected admin account may view or edit these rules at all. If
// any Admin could reassign a restricted rule, they could trivially add
// themselves as an approver on it — defeating the entire point of hiding
// a task from every Admin except a chosen few.
function requireSuperAdmin(req, res, next) {
  if (req.user.userId !== PROTECTED_USER_ID) {
    return res.status(403).json({ message: 'Only the Super Admin account can manage approval routing.' });
  }
  next();
}
router.use(requireSuperAdmin);

router.get('/', async (req, res) => {
  const [rules] = await pool.query('SELECT id, module_key, action, approver_ids, created_at FROM approval_routing_rules ORDER BY created_at DESC');
  // approver_ids is a MySQL JSON column — mysql2 auto-deserializes it into
  // a real array already, not a string needing JSON.parse. Resolved here
  // into { id, user_id } pairs purely for display; the stored rule itself
  // only ever needs the bare ids.
  for (const rule of rules) {
    if (rule.approver_ids.length) {
      const placeholders = rule.approver_ids.map(() => '?').join(',');
      const [approvers] = await pool.query(`SELECT id, user_id FROM users WHERE id IN (${placeholders})`, rule.approver_ids);
      rule.approvers = approvers;
    } else {
      rule.approvers = [];
    }
    delete rule.approver_ids;
  }
  res.json(rules);
});

// Accounts eligible to be picked as an approver on any rule — active
// Admins with "Can approve" turned on. The protected admin account is
// deliberately excluded here since it's already the guaranteed fallback
// for every rule and doesn't need to be separately assigned to one.
router.get('/eligible-approvers', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.user_id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.role_name = 'Admin' AND u.status = 'ACTIVE' AND u.can_approve = 1 AND u.user_id != ?`,
    [PROTECTED_USER_ID]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { module_key, action, approver_ids } = req.body;
  if (!Array.isArray(approver_ids) || !approver_ids.length) {
    return res.status(400).json({ message: 'At least one approver is required' });
  }
  if (!module_key && !action) {
    return res.status(400).json({ message: 'A rule needs at least a module or an action — "any module, any action" would route everything' });
  }
  // Users -> any action is a hard-coded, permanent exception (see
  // utils/approvalRouting.js) — it can never be configured as a regular
  // rule, so it can't be edited or accidentally reassigned this way either.
  if (module_key === 'users') {
    return res.status(400).json({ message: 'Changes to Users are always routed to the Super Admin only, and cannot be reassigned here.' });
  }

  const [result] = await pool.query(
    'INSERT INTO approval_routing_rules (module_key, action, approver_ids) VALUES (?, ?, ?)',
    [module_key || null, action || null, JSON.stringify(approver_ids)]
  );
  res.status(201).json({ id: result.insertId });
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM approval_routing_rules WHERE id = ?', [req.params.id]);
  res.json({ message: 'Rule deleted' });
});

module.exports = router;
