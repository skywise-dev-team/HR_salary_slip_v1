const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange } = require('../middleware/auth');
const { establishmentAssets } = require('../middleware/upload');
const { logActivity } = require('../utils/activityLog');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

router.get('/', requirePermission('establishments', 'view'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM establishments ORDER BY name');
  res.json(rows);
});

router.get('/:id', requirePermission('establishments', 'view'), async (req, res) => {
  const [[row]] = await pool.query('SELECT * FROM establishments WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ message: 'Establishment not found' });
  res.json(row);
});

router.post(
  '/',
  requirePermission('establishments', 'edit'),
  establishmentAssets.fields([{ name: 'logo', maxCount: 1 }, { name: 'signature', maxCount: 1 }]),
  async (req, res) => {
    const { est_code, name, signatory_name, address } = req.body;
    if (!est_code || !name) return res.status(400).json({ message: 'Establishment code and name are required' });

    const logoPath = req.files?.logo?.[0]?.filename || null;
    const signaturePath = req.files?.signature?.[0]?.filename || null;

    try {
      const [result] = await pool.query(
        `INSERT INTO establishments (est_code, name, signatory_name, address, logo_path, signature_path)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [est_code, name, signatory_name || null, address || null, logoPath, signaturePath]
      );
      res.status(201).json({ id: result.insertId });
      await logActivity(req, 'CREATE', 'establishments', `Created establishment ${est_code} (${name})`);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Establishment code already exists' });
      throw err;
    }
  }
);

router.put(
  '/:id',
  requirePermission('establishments', 'edit'),
  establishmentAssets.fields([{ name: 'logo', maxCount: 1 }, { name: 'signature', maxCount: 1 }]),
  async (req, res) => {
    const { est_code, name, signatory_name, address } = req.body;
    const fields = [est_code, name, signatory_name || null, address || null];
    let sql = `UPDATE establishments SET est_code=?, name=?, signatory_name=?, address=?`;

    if (req.files?.logo?.[0]) { sql += ', logo_path=?'; fields.push(req.files.logo[0].filename); }
    if (req.files?.signature?.[0]) { sql += ', signature_path=?'; fields.push(req.files.signature[0].filename); }
    sql += ' WHERE id=?';
    fields.push(req.params.id);

    await pool.query(sql, fields);
    res.json({ message: 'Establishment updated' });
    await logActivity(req, 'UPDATE', 'establishments', `Updated establishment ${est_code}`);
  }
);

router.delete('/:id', requirePermission('establishments', 'delete'), async (req, res) => {
  const [[est]] = await pool.query('SELECT est_code FROM establishments WHERE id = ?', [req.params.id]);
  await pool.query('DELETE FROM establishments WHERE id = ?', [req.params.id]);
  res.json({ message: 'Establishment deleted' });
  if (est) await logActivity(req, 'DELETE', 'establishments', `Deleted establishment ${est.est_code}`);
});

module.exports = router;
