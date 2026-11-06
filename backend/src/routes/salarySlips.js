const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const archiver = require('archiver');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange } = require('../middleware/auth');
const { generateSlipBuffer, generateArrearSlipBuffer } = require('../utils/slipService');
const { addScope, allowEstablishment } = require('../utils/establishmentScope');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Strips characters that are unsafe in file/folder names on Windows/macOS/Linux.
const sanitizeName = (str) => String(str || '').replace(/[\\/:*?"<>|]/g, '').trim();

// "Md Irfan Ansari_1527515_June-2026.pdf" — employee name, employee ID, period.
function slipDownloadName(fullName, empCode, month, year) {
  return `${sanitizeName(fullName)}_${sanitizeName(empCode)}_${MONTHS[month]}-${year}.pdf`;
}

// A "salary slip" is no longer its own stored entity — every salary_data
// row always has one, generated fresh on demand the moment it's actually
// previewed or downloaded, never saved anywhere. sd.id is what identifies
// one from here on (there's no separate salary_slips.id anymore).
const LIST_SQL = `
  SELECT sd.id, sd.establishment_id, sd.period_month, sd.period_year, sd.net_pay, sd.uploaded_at,
         e.employee_id AS emp_code, e.full_name, es.name AS establishment_name
  FROM salary_data sd
  JOIN employees e ON e.id = sd.employee_id
  JOIN establishments es ON es.id = sd.establishment_id`;

function buildFilters(query) {
  const { establishment_id, month, year, search } = query;
  const clauses = [];
  const params = [];
  if (establishment_id) { clauses.push('sd.establishment_id = ?'); params.push(establishment_id); }
  if (month) { clauses.push('sd.period_month = ?'); params.push(month); }
  if (year) { clauses.push('sd.period_year = ?'); params.push(year); }
  if (search) { clauses.push('(e.employee_id LIKE ? OR e.full_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Resolves the "restrict to own records" id for this request, or null for
// no restriction. An Employee Master-provisioned login (source: 'employee')
// is always restricted to its own record — we already know its employees.id
// directly from the authenticated session (see middleware/auth.js), so no
// lookup is needed. A users-table login (Admin/HR/any manually-created
// staff account) is never an end-user employee login under this design, so
// it always gets full visibility, governed purely by its role's
// salary_slips permission via the requirePermission middleware already
// applied to every route below.
function resolveOwnEmployeeId(req) {
  return req.user.source === 'employee' ? req.user.id : null;
}

// Appends "sd.employee_id = ?" to an existing WHERE clause (or creates one),
// only when ownEmployeeId is set. Used by every endpoint below that lists or
// bulk-serves slips, so an employee login's results are always additionally
// scoped to their own records on top of whatever other filters were applied.
function restrictToOwn(where, params, ownEmployeeId) {
  if (!ownEmployeeId) return { where, params };
  return {
    where: where ? `${where} AND sd.employee_id = ?` : 'WHERE sd.employee_id = ?',
    params: [...params, ownEmployeeId]
  };
}

// Appends the establishment limit of a staff account (see
// utils/establishmentScope.js) to a WHERE clause, so slips of establishments
// the account has no access to never appear in a list, preview or download.
function restrictToScope(req, where, params) {
  const clauses = [];
  const extra = [];
  addScope(req, clauses, extra, 'sd.establishment_id');
  if (!clauses.length) return { where, params };
  return {
    where: where ? `${where} AND ${clauses.join(' AND ')}` : `WHERE ${clauses.join(' AND ')}`,
    params: [...params, ...extra]
  };
}

router.get('/', requirePermission('salary_slips', 'view'), async (req, res) => {
  const filtered = buildFilters(req.query);
  const ownEmployeeId = resolveOwnEmployeeId(req);
  const own = restrictToOwn(filtered.where, filtered.params, ownEmployeeId);
  const { where, params } = restrictToScope(req, own.where, own.params);
  const [rows] = await pool.query(`${LIST_SQL} ${where} ORDER BY sd.uploaded_at DESC`, params);
  res.json(rows);
});

// The most recent pay period that has any salary data at all — what the
// Salary Slips page opens on. An employee login only ever sees its own
// latest period. Returns null when nothing has been uploaded yet.
router.get('/latest-period', requirePermission('salary_slips', 'view'), async (req, res) => {
  const ownEmployeeId = resolveOwnEmployeeId(req);
  const clauses = [];
  const params = [];
  if (ownEmployeeId) { clauses.push('employee_id = ?'); params.push(ownEmployeeId); }
  addScope(req, clauses, params, 'establishment_id');
  const [[row]] = await pool.query(
    `SELECT period_month, period_year FROM salary_data
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY period_year DESC, period_month DESC LIMIT 1`,
    params
  );
  res.json(row || null);
});

// Inline preview — for anyone with salary_slips view access, except
// NO_ACCESS. Generated fresh, right now, from this record's frozen
// slip_snapshot — never read from or written to disk.
router.get('/:id/preview', requirePermission('salary_slips', 'view'), async (req, res) => {
  if (req.user.salarySlipAccess === 'NO_ACCESS') {
    return res.status(403).json({ message: 'You do not have access to salary slips' });
  }
  const [[sd]] = await pool.query('SELECT id, employee_id, establishment_id FROM salary_data WHERE id = ?', [req.params.id]);
  if (!sd) return res.status(404).json({ message: 'Salary slip not found' });
  if (!allowEstablishment(req, res, sd.establishment_id, 'You do not have access to this establishment\'s salary slips.')) return;

  const ownEmployeeId = resolveOwnEmployeeId(req);
  if (ownEmployeeId && sd.employee_id !== ownEmployeeId) {
    return res.status(403).json({ message: 'You can only view your own salary slips' });
  }

  const buffer = await generateSlipBuffer(sd.id);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(buffer);
});

// Actual file download — only for users whose salary_slip_access is
// VIEW_DOWNLOAD. VIEW_ONLY users are limited to the inline preview above.
// Downloaded filename is Employee Name_Employee ID_Month-Year.pdf.
// Generated fresh, right now — never read from disk.
router.get('/:id/download', requirePermission('salary_slips', 'view'), async (req, res) => {
  if (req.user.salarySlipAccess !== 'VIEW_DOWNLOAD') {
    return res.status(403).json({ message: 'Your account is not permitted to download salary slips' });
  }
  const [[sd]] = await pool.query(
    `SELECT sd.id, sd.employee_id, sd.establishment_id, sd.period_month, sd.period_year, e.employee_id AS emp_code, e.full_name
     FROM salary_data sd JOIN employees e ON e.id = sd.employee_id
     WHERE sd.id = ?`,
    [req.params.id]
  );
  if (!sd) return res.status(404).json({ message: 'Salary slip not found' });
  if (!allowEstablishment(req, res, sd.establishment_id, 'You do not have access to this establishment\'s salary slips.')) return;

  const ownEmployeeId = resolveOwnEmployeeId(req);
  if (ownEmployeeId && sd.employee_id !== ownEmployeeId) {
    return res.status(403).json({ message: 'You can only download your own salary slips' });
  }

  const buffer = await generateSlipBuffer(sd.id);
  const downloadName = slipDownloadName(sd.full_name, sd.emp_code, sd.period_month, sd.period_year);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
  res.setHeader('Content-Type', 'application/pdf');
  res.send(buffer);

  // Backend-only tracking, never exposed to the frontend — only counts as
  // "the employee downloaded it" when the download is actually performed by
  // the employee's own self-service login, not an Admin/HR download on
  // their behalf. Stays 1 no matter how many further times they download
  // it; automatically reset to 0 elsewhere whenever this record is edited.
  if (req.user.source === 'employee') {
    pool.query('UPDATE salary_data SET downloaded = 1 WHERE id = ?', [sd.id])
      .catch((err) => console.error('Failed to set salary_data.downloaded flag:', err.message));
  }
});

// Bulk ZIP download organized into one folder per establishment inside the
// archive: {Establishment Name}/{Employee Name}_{Employee ID}_{Month-Year}.pdf
// Pass ?ids=1,2,3 (salary_data.id values) to download an exact selection —
// e.g. from checkboxes in the UI — otherwise falls back to the same
// establishment/month/year/search filters used by the list view. Every PDF
// is generated fresh as the ZIP is built — none of this is ever read from
// or written to disk. Same VIEW_DOWNLOAD-only restriction as the
// single-file download.
router.get('/bulk-download', requirePermission('salary_slips', 'view'), async (req, res) => {
  if (req.user.salarySlipAccess !== 'VIEW_DOWNLOAD') {
    return res.status(403).json({ message: 'Your account is not permitted to download salary slips' });
  }

  const ownEmployeeId = resolveOwnEmployeeId(req);

  let rows;
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.status(400).json({ message: 'No valid slip ids provided' });
    const placeholders = ids.map(() => '?').join(',');
    const own = restrictToOwn(`WHERE sd.id IN (${placeholders})`, ids, ownEmployeeId);
    const { where, params } = restrictToScope(req, own.where, own.params);
    [rows] = await pool.query(`${LIST_SQL} ${where} ORDER BY es.name, e.full_name`, params);
  } else {
    const filtered = buildFilters(req.query);
    const own = restrictToOwn(filtered.where, filtered.params, ownEmployeeId);
    const { where, params } = restrictToScope(req, own.where, own.params);
    [rows] = await pool.query(`${LIST_SQL} ${where} ORDER BY es.name, e.full_name`, params);
  }

  if (!rows.length) {
    return res.status(404).json({ message: 'No salary slips found for this selection' });
  }

  const { month, year, establishment_id } = req.query;
  const zipNameParts = ['salary-slips'];
  if (establishment_id) {
    const matchingRow = rows.find((r) => String(r.establishment_id) === String(establishment_id));
    if (matchingRow) zipNameParts.push(sanitizeName(matchingRow.establishment_name));
  }
  if (month && year) zipNameParts.push(`${MONTHS[month]}-${year}`);
  else if (year) zipNameParts.push(String(year));
  const zipFilename = `${zipNameParts.join('_')}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { throw err; });
  archive.pipe(res);

  for (const row of rows) {
    const buffer = await generateSlipBuffer(row.id);
    const folder = sanitizeName(row.establishment_name) || 'Establishment';
    const entryName = slipDownloadName(row.full_name, row.emp_code, row.period_month, row.period_year);
    archive.append(buffer, { name: `${folder}/${entryName}` });
  }

  await archive.finalize();

  // Backend-only tracking, never exposed to the frontend — see the note on
  // the single-file download route above for the exact rule.
  if (req.user.source === 'employee') {
    const salaryDataIds = rows.map((r) => r.id);
    const placeholders2 = salaryDataIds.map(() => '?').join(',');
    pool.query(`UPDATE salary_data SET downloaded = 1 WHERE id IN (${placeholders2})`, salaryDataIds)
      .catch((err) => console.error('Failed to set salary_data.downloaded flag:', err.message));
  }
});

// ===========================================================================
// ARREAR SLIPS — same rules as the monthly slips above (same salary_slips
// permission, VIEW_ONLY can only preview, VIEW_DOWNLOAD can also download,
// an employee login only sees its own, establishment limits apply) and the
// same real-time behaviour: every preview/download is generated fresh from
// the arrear record and nothing is ever saved on the server.
// ===========================================================================
const ARREAR_LIST_SQL = `
  SELECT a.id, a.establishment_id, a.employee_id,
         a.arrear_from_month, a.arrear_from_year, a.arrear_to_month, a.arrear_to_year,
         DATE_FORMAT(a.date_of_issue, '%d-%m-%Y') AS date_of_issue_text,
         a.net_pay, a.uploaded_at,
         e.employee_id AS emp_code, e.full_name, es.name AS establishment_name
  FROM arrear_data a
  JOIN employees e ON e.id = a.employee_id
  JOIN establishments es ON es.id = a.establishment_id`;

// month / year here mean the FIRST month of the arrear period.
function arrearWhere(req) {
  const { establishment_id, month, year, search } = req.query;
  const clauses = [];
  const params = [];
  if (establishment_id) { clauses.push('a.establishment_id = ?'); params.push(establishment_id); }
  if (month) { clauses.push('a.arrear_from_month = ?'); params.push(month); }
  if (year) { clauses.push('a.arrear_from_year = ?'); params.push(year); }
  if (search) { clauses.push('(e.employee_id LIKE ? OR e.full_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const own = resolveOwnEmployeeId(req);
  if (own) { clauses.push('a.employee_id = ?'); params.push(own); }
  addScope(req, clauses, params, 'a.establishment_id');
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function arrearDownloadName(fullName, empCode, r) {
  return `${sanitizeName(fullName)}_${sanitizeName(empCode)}_Arrear_${MONTHS[r.arrear_from_month]}-${r.arrear_from_year}_to_${MONTHS[r.arrear_to_month]}-${r.arrear_to_year}.pdf`;
}

router.get('/arrear', requirePermission('salary_slips', 'view'), async (req, res) => {
  if (req.user.salarySlipAccess === 'NO_ACCESS') return res.json([]);
  const { where, params } = arrearWhere(req);
  const [rows] = await pool.query(
    `${ARREAR_LIST_SQL} ${where} ORDER BY a.arrear_from_year DESC, a.arrear_from_month DESC, es.name, e.full_name`, params
  );
  res.json(rows);
});

// Loads one arrear row and applies the same checks every single-slip route needs.
async function loadArrearForRequest(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(404).json({ message: 'Arrear slip not found' }); return null; }
  const [[a]] = await pool.query(
    `SELECT a.id, a.employee_id, a.establishment_id, a.arrear_from_month, a.arrear_from_year, a.arrear_to_month, a.arrear_to_year,
            e.employee_id AS emp_code, e.full_name
     FROM arrear_data a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?`, [id]
  );
  if (!a) { res.status(404).json({ message: 'Arrear slip not found' }); return null; }
  if (!allowEstablishment(req, res, a.establishment_id, 'You do not have access to this establishment\'s salary slips.')) return null;
  const own = resolveOwnEmployeeId(req);
  if (own && a.employee_id !== own) { res.status(403).json({ message: 'You can only view your own salary slips' }); return null; }
  return a;
}

router.get('/arrear/:id/preview', requirePermission('salary_slips', 'view'), async (req, res) => {
  if (req.user.salarySlipAccess === 'NO_ACCESS') {
    return res.status(403).json({ message: 'You do not have access to salary slips' });
  }
  const a = await loadArrearForRequest(req, res);
  if (!a) return;
  const buffer = await generateArrearSlipBuffer(a.id);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(buffer);
});

router.get('/arrear/:id/download', requirePermission('salary_slips', 'view'), async (req, res) => {
  if (req.user.salarySlipAccess !== 'VIEW_DOWNLOAD') {
    return res.status(403).json({ message: 'Your account is not permitted to download salary slips' });
  }
  const a = await loadArrearForRequest(req, res);
  if (!a) return;
  const buffer = await generateArrearSlipBuffer(a.id);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(arrearDownloadName(a.full_name, a.emp_code, a))}"`);
  res.setHeader('Content-Type', 'application/pdf');
  res.send(buffer);
});

// ZIP of arrear slips, one folder per establishment — ?ids=1,2,3 for an exact
// selection, otherwise the same filters as the list. Generated as the ZIP is
// built; nothing is saved.
router.get('/arrear-bulk-download', requirePermission('salary_slips', 'view'), async (req, res) => {
  if (req.user.salarySlipAccess !== 'VIEW_DOWNLOAD') {
    return res.status(403).json({ message: 'Your account is not permitted to download salary slips' });
  }
  const base = arrearWhere(req);
  let where = base.where;
  let params = base.params;
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.status(400).json({ message: 'No valid slip ids provided' });
    where = where ? `${where} AND a.id IN (?)` : 'WHERE a.id IN (?)';
    params = [...params, ids];
  }
  const [rows] = await pool.query(`${ARREAR_LIST_SQL} ${where} ORDER BY es.name, e.full_name`, params);
  if (!rows.length) return res.status(404).json({ message: 'No arrear slips found for this selection' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="arrear-salary-slips.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { throw err; });
  archive.pipe(res);
  for (const row of rows) {
    const buffer = await generateArrearSlipBuffer(row.id);
    const folder = sanitizeName(row.establishment_name) || 'Establishment';
    archive.append(buffer, { name: `${folder}/${arrearDownloadName(row.full_name, row.emp_code, row)}` });
  }
  await archive.finalize();
});

module.exports = router;
