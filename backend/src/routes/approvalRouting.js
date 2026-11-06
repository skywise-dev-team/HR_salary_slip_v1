const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange } = require('../middleware/auth');
const { PROTECTED_USER_ID } = require('../utils/approvalRouting');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

// Access is governed by the "Approval Routing" module in Roles & Permissions
// (view / edit / delete), like every other module — not hard-wired to one
// account. Give it only to people who may decide who approves what.

router.get('/', requirePermission('approval_routing', 'view'), async (req, res) => {
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

// Accounts that can be picked as an approver on a rule - every active account
// with "Can approve" turned on, whatever its role. Each comes back with the
// establishments it has access to, because a request is only ever sent to an
// approver who has access to the establishment(s) the request is about. The
// protected admin account is excluded: it already sees every request and is
// the guaranteed fallback.
router.get('/eligible-approvers', requirePermission('approval_routing', 'view'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.user_id, u.all_establishments, r.role_name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'ACTIVE' AND u.can_approve = 1 AND u.user_id != ? ORDER BY u.user_id`,
    [PROTECTED_USER_ID]
  );
  const restricted = rows.filter((u) => !u.all_establishments).map((u) => u.id);
  const names = {};
  if (restricted.length) {
    const [links] = await pool.query(
      `SELECT ue.user_id, e.name FROM user_establishments ue JOIN establishments e ON e.id = ue.establishment_id
       WHERE ue.user_id IN (?) ORDER BY e.name`, [restricted]
    );
    links.forEach((l) => { (names[l.user_id] = names[l.user_id] || []).push(l.name); });
  }
  res.json(rows.map((u) => ({
    id: u.id,
    user_id: u.user_id,
    role_name: u.role_name,
    // An Admin-role account with no establishments chosen covers all of them.
    all_establishments: !!u.all_establishments || (u.role_name === 'Admin' && !(names[u.id] || []).length),
    establishments: names[u.id] || []
  })));
});

router.post('/', requirePermission('approval_routing', 'edit'), async (req, res) => {
  const { module_key, action, approver_ids } = req.body;
  if (!Array.isArray(approver_ids) || !approver_ids.length) {
    return res.status(400).json({ message: 'At least one approver is required' });
  }
  if (!module_key && !action) {
    return res.status(400).json({ message: 'A rule needs at least a module or an action — "any module, any action" would route everything' });
  }
  const [result] = await pool.query(
    'INSERT INTO approval_routing_rules (module_key, action, approver_ids) VALUES (?, ?, ?)',
    [module_key || null, action || null, JSON.stringify(approver_ids)]
  );
  res.status(201).json({ id: result.insertId });
});

// Replaces the stored rules of one displayed row (one module, same approvers,
// several actions) with a new set, in one go: used by the Edit option.
router.put('/replace', requirePermission('approval_routing', 'edit'), async (req, res) => {
  const { replace_ids, module_key, actions, approver_ids } = req.body;
  const oldIds = (Array.isArray(replace_ids) ? replace_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const approvers = (Array.isArray(approver_ids) ? approver_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const actionList = Array.isArray(actions) && actions.length ? [...new Set(actions)] : [null];
  if (!oldIds.length) return res.status(400).json({ message: 'No rule selected to edit' });
  if (!approvers.length) return res.status(400).json({ message: 'At least one approver is required' });
  if (!module_key && actionList[0] === null) {
    return res.status(400).json({ message: 'A rule needs at least a module or an action — "any module, any action" would route everything' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM approval_routing_rules WHERE id IN (?)', [oldIds]);
    for (const action of actionList) {
      await conn.query(
        'INSERT INTO approval_routing_rules (module_key, action, approver_ids) VALUES (?, ?, ?)',
        [module_key || null, action, JSON.stringify(approvers)]
      );
    }
    await conn.commit();
    res.json({ message: 'Rule updated' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

router.delete('/:id', requirePermission('approval_routing', 'delete'), async (req, res) => {
  await pool.query('DELETE FROM approval_routing_rules WHERE id = ?', [req.params.id]);
  res.json({ message: 'Rule deleted' });
});

module.exports = router;
