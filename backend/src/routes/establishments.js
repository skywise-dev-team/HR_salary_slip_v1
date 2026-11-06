const { futureDateError, toIso } = require('../utils/employmentWindow');
const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireAnyView, requireNotPendingPasswordChange } = require('../middleware/auth');
const { establishmentAssets } = require('../middleware/upload');
const { logActivity } = require('../utils/activityLog');
const { isAdminUser, createApprovalRequest } = require('../utils/approvals');
const { recordVersion } = require('../utils/effectiveDating');
const { isRestricted, addScope, allowEstablishment } = require('../utils/establishmentScope');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

router.get('/', requirePermission('establishments', 'view'), async (req, res) => {
  const clauses = [];
  const params = [];
  addScope(req, clauses, params, 'id');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(`SELECT * FROM establishments ${where} ORDER BY name`, params);
  res.json(rows);
});

// Short pick-list (id, code, name) of the establishments this account can
// access. Works with any of the modules that need to choose an establishment.
router.get('/lookup', requireAnyView(['establishments', 'employees', 'upload_salary', 'salary_slips']), async (req, res) => {
  const clauses = [];
  const params = [];
  addScope(req, clauses, params, 'id');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(`SELECT id, est_code, name FROM establishments ${where} ORDER BY name`, params);
  res.json(rows);
});

router.get('/:id', requirePermission('establishments', 'view'), async (req, res) => {
  const [[row]] = await pool.query('SELECT * FROM establishments WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ message: 'Establishment not found' });
  if (!allowEstablishment(req, res, row.id)) return;
  res.json(row);
});

// Creating a new establishment always applies immediately, for every role —
// unlike editing or deleting, a brand-new establishment has nothing linked
// to it yet (no employees, no salary slips), so there's nothing an approval
// step would actually be protecting.
router.post(
  '/',
  requirePermission('establishments', 'edit'),
  establishmentAssets.fields([{ name: 'logo', maxCount: 1 }, { name: 'signature', maxCount: 1 }]),
  async (req, res) => {
    const { est_code, name, signatory_name, address, effective_date } = req.body;
    if (!est_code || !name) return res.status(400).json({ message: 'Establishment code and name are required' });
    const futureErr = futureDateError('Establishment', 'Effective from date', toIso(effective_date));
    if (futureErr) return res.status(400).json({ message: futureErr });

    const logoPath = req.files?.logo?.[0]?.filename || null;
    const signaturePath = req.files?.signature?.[0]?.filename || null;

    try {
      const [result] = await pool.query(
        `INSERT INTO establishments (est_code, name, signatory_name, address, logo_path, signature_path)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [est_code, name, signatory_name || null, address || null, logoPath, signaturePath]
      );
      await recordVersion(pool, 'establishment', result.insertId, effective_date);
      // Someone limited to certain establishments gets access to the one they
      // just created, otherwise they could not see it afterwards.
      if (isRestricted(req)) {
        await pool.query('INSERT IGNORE INTO user_establishments (user_id, establishment_id) VALUES (?, ?)', [req.user.id, result.insertId]);
      }
      res.status(201).json({ id: result.insertId });
      await logActivity(req, 'CREATE', 'establishments', `Created establishment ${est_code} (${name})`, result.insertId);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Establishment code already exists' });
      throw err;
    }
  }
);

// Applies an edit directly — shared by the immediate-Admin path below and
// the later approved-request dispatch path. logo_path/signature_path are
// only ever set in the UPDATE when a new file was actually uploaded with
// this specific request — an approval with no new file leaves whatever
// logo/signature the establishment already has untouched, exactly like the
// Admin-immediate path has always worked.
//
// effective_date says from which pay month the new name / address /
// signatory / logo / signature apply: salary data of earlier months keeps
// the old details, that month and later months use the new ones.
async function applyUpdateEstablishment(id, payload) {
  const { est_code, name, signatory_name, address, logo_path, signature_path, effective_date } = payload;
  const fields = [est_code, name, signatory_name || null, address || null];
  let sql = `UPDATE establishments SET est_code=?, name=?, signatory_name=?, address=?`;

  if (logo_path) { sql += ', logo_path=?'; fields.push(logo_path); }
  if (signature_path) { sql += ', signature_path=?'; fields.push(signature_path); }
  sql += ' WHERE id=?';
  fields.push(id);

  await pool.query(sql, fields);
  await recordVersion(pool, 'establishment', id, effective_date);
  return {};
}

// Editing an existing establishment is staged for approval for non-Admins —
// its name, address, signatory, logo and signature all appear on every
// salary slip issued under it, and on every employee record linked to it.
router.put(
  '/:id',
  requirePermission('establishments', 'edit'),
  establishmentAssets.fields([{ name: 'logo', maxCount: 1 }, { name: 'signature', maxCount: 1 }]),
  async (req, res) => {
    if (!allowEstablishment(req, res, req.params.id)) return;
    const { est_code, name, signatory_name, address, effective_date } = req.body;
    const futureErr = futureDateError('Establishment', 'Effective from date', toIso(effective_date));
    if (futureErr) return res.status(400).json({ message: futureErr });
    // Captured now, before staging — multer has already written any
    // uploaded file to disk under its own unique filename by this point,
    // so this reference stays valid whenever the request is later approved,
    // exactly like an Excel import's staged file does.
    const payload = {
      est_code, name, signatory_name, address, effective_date,
      logo_path: req.files?.logo?.[0]?.filename || null,
      signature_path: req.files?.signature?.[0]?.filename || null
    };

    if (!isAdminUser(req)) {
      await createApprovalRequest({
        req, moduleKey: 'establishments', action: 'UPDATE', targetId: req.params.id, payload,
        description: `Edit establishment ID ${req.params.id}`
      });
      return res.status(202).json({ message: 'Submitted for approval, pending.' });
    }

    await applyUpdateEstablishment(req.params.id, payload);
    res.json({ message: 'Establishment updated' });
    await logActivity(req, 'UPDATE', 'establishments', `Updated establishment ${est_code}`, Number(req.params.id));
  }
);

async function applyDeleteEstablishment(id) {
  const [[est]] = await pool.query('SELECT est_code FROM establishments WHERE id = ?', [id]);
  await pool.query('DELETE FROM establishments WHERE id = ?', [id]);
  return est;
}

// Deleting an establishment is staged for approval for non-Admins — the
// same reasoning as editing: employees and salary slips are linked to it
// directly.
router.delete('/:id', requirePermission('establishments', 'delete'), async (req, res) => {
  if (!allowEstablishment(req, res, req.params.id)) return;
  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'establishments', action: 'DELETE', targetId: req.params.id,
      description: `Delete establishment ID ${req.params.id}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const est = await applyDeleteEstablishment(req.params.id);
  res.json({ message: 'Establishment deleted' });
  if (est) await logActivity(req, 'DELETE', 'establishments', `Deleted establishment ${est.est_code}`);
});

async function applyApprovedEstablishmentsAction(action, targetId, payload) {
  switch (action) {
    case 'UPDATE':
      return applyUpdateEstablishment(targetId, payload);
    case 'DELETE':
      return applyDeleteEstablishment(targetId);
    default:
      throw new Error(`Unknown action "${action}" for establishments`);
  }
}

module.exports = router;
module.exports.applyApprovedAction = applyApprovedEstablishmentsAction;
