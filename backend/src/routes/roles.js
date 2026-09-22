const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange } = require('../middleware/auth');
const { MODULES } = require('../config/modules');
const { logActivity } = require('../utils/activityLog');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

router.get('/modules', requireAuth, (req, res) => res.json(MODULES));

router.get('/', requirePermission('roles_permissions', 'view'), async (req, res) => {
  const [roles] = await pool.query('SELECT * FROM roles ORDER BY role_name');
  const [modules] = await pool.query('SELECT * FROM role_modules');

  const withModules = roles.map((r) => ({
    ...r,
    modules: modules.filter((m) => m.role_id === r.id).map((m) => m.module_key)
  }));
  res.json(withModules);
});

router.get('/:id', requirePermission('roles_permissions', 'view'), async (req, res) => {
  const [[role]] = await pool.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
  if (!role) return res.status(404).json({ message: 'Role not found' });

  const [rows] = await pool.query(
    'SELECT module_key, can_view, can_edit, can_delete FROM role_modules WHERE role_id = ?',
    [req.params.id]
  );

  res.json({
    ...role,
    modules: rows.map((r) => r.module_key),
    permissions: rows.map((r) => ({ module_key: r.module_key, can_view: r.can_view, can_edit: r.can_edit, can_delete: r.can_delete }))
  });
});

router.post('/', requirePermission('roles_permissions', 'edit'), async (req, res) => {
  const { role_name, description, modules } = req.body;
  if (!role_name || !Array.isArray(modules) || modules.length === 0) {
    return res.status(400).json({ message: 'Role name and at least one module are required' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      'INSERT INTO roles (role_name, description) VALUES (?, ?)',
      [role_name, description || null]
    );
    const roleId = result.insertId;

    for (const moduleKey of modules) {
      // Selecting a module grants View by default; Edit/Delete stay off
      // until explicitly granted via Manage Access.
      await conn.query(
        'INSERT INTO role_modules (role_id, module_key, can_view, can_edit, can_delete) VALUES (?, ?, 1, 0, 0)',
        [roleId, moduleKey]
      );
    }

    await conn.commit();
    res.status(201).json({ id: roleId });
    await logActivity(req, 'CREATE', 'roles_permissions', `Created role "${role_name}" with modules: ${modules.join(', ')}`);
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Role name already exists' });
    throw err;
  } finally {
    conn.release();
  }
});

router.put('/:id', requirePermission('roles_permissions', 'edit'), async (req, res) => {
  const { role_name, description, modules } = req.body;
  const roleId = req.params.id;

  await pool.query('UPDATE roles SET role_name=?, description=? WHERE id=?', [role_name, description || null, roleId]);

  if (Array.isArray(modules)) {
    const [existing] = await pool.query('SELECT module_key FROM role_modules WHERE role_id = ?', [roleId]);
    const existingKeys = existing.map((m) => m.module_key);

    const toAdd = modules.filter((m) => !existingKeys.includes(m));
    const toRemove = existingKeys.filter((m) => !modules.includes(m));

    for (const moduleKey of toAdd) {
      await pool.query(
        'INSERT INTO role_modules (role_id, module_key, can_view, can_edit, can_delete) VALUES (?, ?, 1, 0, 0)',
        [roleId, moduleKey]
      );
    }
    for (const moduleKey of toRemove) {
      await pool.query('DELETE FROM role_modules WHERE role_id = ? AND module_key = ?', [roleId, moduleKey]);
    }
  }

  res.json({ message: 'Role updated' });
  await logActivity(req, 'UPDATE', 'roles_permissions', `Updated role "${role_name}" (ID ${roleId})`);
});

// Manage Access: bulk-set the View/Edit/Delete matrix for a role
router.put('/:id/permissions', requirePermission('roles_permissions', 'edit'), async (req, res) => {
  const { permissions } = req.body; // [{ module_key, can_view, can_edit, can_delete }]
  if (!Array.isArray(permissions)) return res.status(400).json({ message: 'permissions array is required' });

  for (const p of permissions) {
    await pool.query(
      `INSERT INTO role_modules (role_id, module_key, can_view, can_edit, can_delete)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE can_view=VALUES(can_view), can_edit=VALUES(can_edit), can_delete=VALUES(can_delete)`,
      [req.params.id, p.module_key, !!p.can_view, !!p.can_edit, !!p.can_delete]
    );
  }
  res.json({ message: 'Permissions updated' });
  const [[role]] = await pool.query('SELECT role_name FROM roles WHERE id = ?', [req.params.id]);
  if (role) await logActivity(req, 'UPDATE', 'roles_permissions', `Updated Manage Access permissions for role "${role.role_name}"`);
});

router.delete('/:id', requirePermission('roles_permissions', 'delete'), async (req, res) => {
  const [[role]] = await pool.query('SELECT role_name FROM roles WHERE id = ?', [req.params.id]);
  await pool.query('DELETE FROM roles WHERE id = ?', [req.params.id]);
  res.json({ message: 'Role deleted' });
  if (role) await logActivity(req, 'DELETE', 'roles_permissions', `Deleted role "${role.role_name}"`);
});

module.exports = router;
