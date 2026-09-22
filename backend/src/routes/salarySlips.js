const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const archiver = require('archiver');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange } = require('../middleware/auth');
const { generateSlipBuffer } = require('../utils/slipService');

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

router.get('/', requirePermission('salary_slips', 'view'), async (req, res) => {
  const filtered = buildFilters(req.query);
  const ownEmployeeId = resolveOwnEmployeeId(req);
  const { where, params } = restrictToOwn(filtered.where, filtered.params, ownEmployeeId);
  const [rows] = await pool.query(`${LIST_SQL} ${where} ORDER BY sd.uploaded_at DESC`, params);
  res.json(rows);
});

// Inline preview — for anyone with salary_slips view access, except
// NO_ACCESS. Generated fresh, right now, from this record's frozen
// slip_snapshot — never read from or written to disk.
router.get('/:id/preview', requirePermission('salary_slips', 'view'), async (req, res) => {
  if (req.user.salarySlipAccess === 'NO_ACCESS') {
    return res.status(403).json({ message: 'You do not have access to salary slips' });
  }
  const [[sd]] = await pool.query('SELECT id, employee_id FROM salary_data WHERE id = ?', [req.params.id]);
  if (!sd) return res.status(404).json({ message: 'Salary slip not found' });

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
    `SELECT sd.id, sd.employee_id, sd.period_month, sd.period_year, e.employee_id AS emp_code, e.full_name
     FROM salary_data sd JOIN employees e ON e.id = sd.employee_id
     WHERE sd.id = ?`,
    [req.params.id]
  );
  if (!sd) return res.status(404).json({ message: 'Salary slip not found' });

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
    const { where, params } = restrictToOwn(`WHERE sd.id IN (${placeholders})`, ids, ownEmployeeId);
    [rows] = await pool.query(`${LIST_SQL} ${where} ORDER BY es.name, e.full_name`, params);
  } else {
    const filtered = buildFilters(req.query);
    const { where, params } = restrictToOwn(filtered.where, filtered.params, ownEmployeeId);
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

module.exports = router;
