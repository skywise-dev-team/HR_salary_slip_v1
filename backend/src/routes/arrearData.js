const asyncRouter = require('../utils/asyncRouter');
const ExcelJS = require('exceljs');
const fs = require('fs');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange } = require('../middleware/auth');
const { excelImport } = require('../middleware/upload');
const { captureSlipSnapshot } = require('../utils/slipService');
const { startImportProgress } = require('../utils/importProgress');
const { findNullCellProblems, nullCellErrorMessage } = require('../utils/nullCellCheck');
const { sendTemplate, sendDataExport } = require('../utils/excelTemplates');
const { logActivity } = require('../utils/activityLog');
const { isAdminUser, createApprovalRequest } = require('../utils/approvals');
const { employmentWindowError, EMP_WINDOW_SQL, issueDateError, issueAfterPeriodError } = require('../utils/employmentWindow');
const { checkFigures } = require('../utils/figureCheck');
const { employeeLabel, recordEmployeesText, arrearRecordLabel, cut } = require('../utils/approvalLabels');
const { isRestricted, inScope, addScope, allowEstablishment, allowRecords } = require('../utils/establishmentScope');

// Arrear salary: same module (Upload Salary Data) and the same permissions as
// the normal monthly upload, but its own table and its own template.
//   The arrear period is the only period on a record:
//   arrear_from_month / arrear_from_year = first month the arrear is for
//   arrear_to_month   / arrear_to_year   = last month the arrear is for (same as from for a single month)
//   date_of_issue = the date printed on the arrear slip, filled in by whoever uploads the record
const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

const TEMPLATE_HEADERS = [
  'employee_id', 'arrear_from_month', 'arrear_from_year', 'arrear_to_month', 'arrear_to_year', 'date_of_issue', 'paid_days',
  'basic', 'hra', 'da', 'conveyance_allowance', 'overtime',
  'pf_deduction', 'esi_deduction', 'pt_deduction', 'tds_deduction', 'other_deduction'
];
const TEMPLATE_EXAMPLE = ['11005001', 4, 2026, 5, 2026, '07-07-2026', 52, 3000, 400, 200, 0, 0, 360, 45, 0, 0, 0];

const EARNINGS_COLUMNS = ['basic', 'da', 'hra', 'conveyance_allowance', 'overtime'];
const DEDUCTION_COLUMNS = ['pf_deduction', 'esi_deduction', 'pt_deduction', 'tds_deduction', 'other_deduction'];
const FIGURE_COLUMNS = ['paid_days', 'basic', 'hra', 'da', 'conveyance_allowance', 'overtime',
  'pf_deduction', 'esi_deduction', 'pt_deduction', 'tds_deduction', 'other_deduction'];
const DELETE_MAX = 5000;

// month 1-12 and a proper 4-digit year.
function validateMonthYear(label, monthRaw, yearRaw) {
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (!Number.isInteger(month) || month < 1 || month > 12) return `${label}_month must be between 1 and 12 (got "${monthRaw}")`;
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return `${label}_year must be a 4-digit year, e.g. 2026 (got "${yearRaw}")`;
  return null;
}

// Date of issue printed on the arrear slip. Accepts an Excel date cell, text
// like 07-07-2026 / 07/07/2026 / 2026-07-07, or an Excel serial number.
// Returns 'YYYY-MM-DD' (what MySQL stores) or null when it is not a real date.
function parseIssueDate(raw) {
  if (raw == null || raw === '') return null;
  let y, m, d;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    y = raw.getUTCFullYear(); m = raw.getUTCMonth() + 1; d = raw.getUTCDate();
  } else if (typeof raw === 'number') {
    const dt = new Date(Math.round((raw - 25569) * 86400000));
    if (Number.isNaN(dt.getTime())) return null;
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  } else {
    const text = String(raw).trim();
    let hit = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (hit) { d = Number(hit[1]); m = Number(hit[2]); y = Number(hit[3]); }
    else {
      hit = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!hit) return null;
      y = Number(hit[1]); m = Number(hit[2]); d = Number(hit[3]);
    }
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2100 || check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const DATE_HELP = 'date_of_issue must be a real date written like 07-07-2026 (DD-MM-YYYY)';

// Arrear FROM and TO valid, and FROM not after TO.
function validatePeriods(b) {
  const from = validateMonthYear('arrear_from', b.arrear_from_month, b.arrear_from_year);
  if (from) return from;
  const to = validateMonthYear('arrear_to', b.arrear_to_month, b.arrear_to_year);
  if (to) return to;
  const key = (m, y) => Number(y) * 12 + Number(m);
  if (key(b.arrear_from_month, b.arrear_from_year) > key(b.arrear_to_month, b.arrear_to_year)) {
    return `the arrear "from" month (${b.arrear_from_month}/${b.arrear_from_year}) cannot be after the "to" month (${b.arrear_to_month}/${b.arrear_to_year})`;
  }
  return null;
}

// Same consistency rules as a normal salary row; the days check uses the
// whole arrear period (first day of FROM to last day of TO).
function validateFigures(getValue, fromMonth, fromYear, toMonth, toYear) {
  const num = (name) => Number(getValue(name)) || 0;
  const basic = num('basic');
  for (const name of ['da', 'hra', 'conveyance_allowance']) {
    if (num(name) > basic) return `${name} (${num(name)}) cannot be greater than basic pay (${basic})`;
  }
  const gross = EARNINGS_COLUMNS.reduce((s, n) => s + num(n), 0);
  const totalDeduction = DEDUCTION_COLUMNS.reduce((s, n) => s + num(n), 0);
  if (totalDeduction > gross) {
    return `total deductions (${totalDeduction}) cannot be greater than gross earnings (${gross}) — this would make net pay negative`;
  }
  if (fromMonth != null && fromYear != null && toMonth != null && toYear != null) {
    const start = new Date(Number(fromYear), Number(fromMonth) - 1, 1);
    const end = new Date(Number(toYear), Number(toMonth), 0);
    const maxDays = Math.round((end - start) / 86400000) + 1;
    if (num('paid_days') > maxDays) return `paid_days (${num('paid_days')}) cannot exceed the number of days in the arrear period (${maxDays})`;
  }
  return null;
}

// ---- No overlapping arrear periods ------------------------------------------
// One employee can never have two arrear records whose month ranges overlap
// (e.g. Apr-26 to Aug-26 and Jun-26 to Aug-26). Checked for a single entry,
// an edit, every row of an Excel upload (against the file itself and against
// what is already saved) and again when an approved request is applied.
const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthKey = (m, y) => Number(y) * 12 + Number(m);
const periodLabel = (fm, fy, tm, ty) => `${MONTH_NAMES[Number(fm)]}-${fy} to ${MONTH_NAMES[Number(tm)]}-${ty}`;
const periodsOverlap = (a, b) => monthKey(a.fm, a.fy) <= monthKey(b.tm, b.ty) && monthKey(b.fm, b.fy) <= monthKey(a.tm, a.ty);

// An existing record of this employee whose period overlaps the given one.
// excludeId: the record being edited. sameRangeIsOk: an Excel upload of the
// exact same range updates that record, so it is not an overlap.
async function findOverlappingArrear(db, employeeId, fm, fy, tm, ty, { excludeId = null, sameRangeIsOk = false } = {}) {
  const [rows] = await db.query(
    `SELECT id, arrear_from_month, arrear_from_year, arrear_to_month, arrear_to_year FROM arrear_data
     WHERE employee_id = ? AND (arrear_from_year * 12 + arrear_from_month) <= ? AND (arrear_to_year * 12 + arrear_to_month) >= ?
       ${excludeId ? 'AND id != ?' : ''}`,
    [employeeId, monthKey(tm, ty), monthKey(fm, fy), ...(excludeId ? [excludeId] : [])]
  );
  return rows.find((r) => !(sameRangeIsOk && Number(r.arrear_from_month) === Number(fm) && Number(r.arrear_from_year) === Number(fy)
    && Number(r.arrear_to_month) === Number(tm) && Number(r.arrear_to_year) === Number(ty))) || null;
}

const overlapMessage = (hit) =>
  `This employee already has an arrear record for ${periodLabel(hit.arrear_from_month, hit.arrear_from_year, hit.arrear_to_month, hit.arrear_to_year)}, which overlaps this period. Arrear periods of one employee cannot overlap - delete or correct the existing record first.`;

// Arrear months must lie within the months the employee is active: not before
// the Active-from month, not after the Inactive month.
function arrearWindowError(emp, fm, fy, tm, ty, label, issueIso) {
  return employmentWindowError(emp, fm, fy, label) || employmentWindowError(emp, tm, ty, label) || issueDateError(emp, issueIso, label) || issueAfterPeriodError(tm, ty, issueIso, label);
}

async function findArrearWindowProblems(sheet, colIndex) {
  const rows = [];
  const codes = new Set();
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const code = row.getCell(colIndex('employee_id')).value;
    if (code == null || String(code).trim() === '') continue;
    const n = (name) => Number(row.getCell(colIndex(name)).value);
    const p = { r, code: String(code).trim(), fm: n('arrear_from_month'), fy: n('arrear_from_year'), tm: n('arrear_to_month'), ty: n('arrear_to_year'), issue: parseIssueDate(row.getCell(colIndex('date_of_issue')).value) };
    if ([p.fm, p.fy, p.tm, p.ty].some((v) => !Number.isFinite(v))) continue;
    rows.push(p);
    codes.add(p.code);
  }
  const byCode = {};
  const list = [...codes];
  for (let i = 0; i < list.length; i += 1000) {
    const [emps] = await pool.query(`${EMP_WINDOW_SQL} WHERE employee_id IN (?)`, [list.slice(i, i + 1000)]);
    emps.forEach((e) => { byCode[e.employee_id] = e; });
  }
  const problems = [];
  for (const p of rows) {
    if (!byCode[p.code]) continue;
    const err = arrearWindowError(byCode[p.code], p.fm, p.fy, p.tm, p.ty, `Employee "${p.code}"`, p.issue);
    if (err) problems.push(`Row ${p.r}: ${err}`);
  }
  return problems;
}

// Rows of one upload that overlap each other, or an already saved record.
async function findOverlapProblems(sheet, colIndex) {
  const byEmp = new Map();
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const code = row.getCell(colIndex('employee_id')).value;
    if (code == null || String(code).trim() === '') continue;
    const n = (name) => Number(row.getCell(colIndex(name)).value);
    const p = { r, fm: n('arrear_from_month'), fy: n('arrear_from_year'), tm: n('arrear_to_month'), ty: n('arrear_to_year') };
    if ([p.fm, p.fy, p.tm, p.ty].some((v) => !Number.isFinite(v))) continue;
    const key = String(code).trim();
    if (!byEmp.has(key)) byEmp.set(key, []);
    byEmp.get(key).push(p);
  }
  const problems = [];
  const codes = [...byEmp.keys()];
  const idOf = {};
  for (let i = 0; i < codes.length; i += 1000) {
    const [emps] = await pool.query('SELECT id, employee_id FROM employees WHERE employee_id IN (?)', [codes.slice(i, i + 1000)]);
    emps.forEach((e) => { idOf[e.employee_id] = e.id; });
  }
  for (const [code, list] of byEmp.entries()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]; const b = list[j];
        const same = a.fm === b.fm && a.fy === b.fy && a.tm === b.tm && a.ty === b.ty;
        if (!same && periodsOverlap(a, b)) {
          problems.push(`Rows ${a.r} and ${b.r}: employee "${code}" has overlapping arrear periods (${periodLabel(a.fm, a.fy, a.tm, a.ty)} and ${periodLabel(b.fm, b.fy, b.tm, b.ty)})`);
        }
      }
      if (idOf[code]) {
        const a = list[i];
        const hit = await findOverlappingArrear(pool, idOf[code], a.fm, a.fy, a.tm, a.ty, { sameRangeIsOk: true });
        if (hit) problems.push(`Row ${a.r}: employee "${code}" ${periodLabel(a.fm, a.fy, a.tm, a.ty)} overlaps an existing arrear record (${periodLabel(hit.arrear_from_month, hit.arrear_from_year, hit.arrear_to_month, hit.arrear_to_year)})`);
      }
    }
  }
  return problems;
}

class OverlapError extends Error {}

function computeTotals(b) {
  const num = (v) => Number(v) || 0;
  const gross = EARNINGS_COLUMNS.reduce((s, n) => s + num(b[n]), 0);
  const totalDed = DEDUCTION_COLUMNS.reduce((s, n) => s + num(b[n]), 0);
  return { gross_earnings: gross, total_deduction: totalDed, net_pay: gross - totalDed };
}

// The same employee + arrear period twice in one file would
// silently overwrite itself, so the whole upload is refused instead.
function findDuplicatesInSheet(sheet, colIndex) {
  const seen = new Map();
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const vals = ['employee_id', 'arrear_from_month', 'arrear_from_year', 'arrear_to_month', 'arrear_to_year'].map((n) => row.getCell(colIndex(n)).value);
    if (vals.some((v) => v == null || String(v).trim() === '')) continue;
    const key = [String(vals[0]).trim(), ...vals.slice(1).map(Number)].join('|');
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(r);
  }
  const problems = [];
  for (const [key, rows] of seen.entries()) {
    if (rows.length > 1) {
      const [emp, fm, fy, tm, ty] = key.split('|');
      problems.push(`Duplicate entry: employee_id "${emp}" for ${fm}/${fy} to ${tm}/${ty} appears in rows ${rows.join(', ')} — only one row per employee and arrear period is allowed`);
    }
  }
  return problems;
}

// For someone limited to some establishments: every row of an upload must be
// for an employee of an establishment they have access to.
async function findEstablishmentScopeProblems(req, sheet, colIndex) {
  if (!isRestricted(req)) return [];
  const rows = [];
  const codes = new Set();
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const raw = row.getCell(colIndex('employee_id')).value;
    if (raw == null || String(raw).trim() === '') continue;
    const code = String(raw).trim();
    codes.add(code);
    rows.push({ r, code });
  }
  const estOf = {};
  const list = [...codes];
  for (let i = 0; i < list.length; i += 1000) {
    const [emps] = await pool.query('SELECT employee_id, establishment_id FROM employees WHERE employee_id IN (?)', [list.slice(i, i + 1000)]);
    emps.forEach((e) => { estOf[e.employee_id] = e.establishment_id; });
  }
  const problems = [];
  for (const { r, code } of rows) {
    if (estOf[code] !== undefined && !inScope(req, estOf[code])) {
      problems.push(`Row ${r}: employee "${code}" belongs to an establishment you do not have access to`);
    }
  }
  return problems;
}

router.get('/template', requirePermission('upload_salary', 'edit'), async (req, res) => {
  await sendTemplate(res, 'arrear-salary-data-template.xlsx', TEMPLATE_HEADERS, TEMPLATE_EXAMPLE);
});

// Downloads one arrear group (establishment + arrear period) in the import
// template's layout, so it can be edited in Excel and uploaded back.
router.get('/export', requirePermission('upload_salary', 'view'), async (req, res) => {
  const { establishment_id, month, year, to_month, to_year } = req.query;
  if (!establishment_id || !month || !year || !to_month || !to_year) {
    return res.status(400).json({ message: 'Establishment and arrear period are required' });
  }
  if (!allowEstablishment(req, res, establishment_id)) return;
  const [rows] = await pool.query(
    `SELECT a.arrear_from_month, a.arrear_from_year, a.arrear_to_month, a.arrear_to_year,
            DATE_FORMAT(a.date_of_issue, '%d-%m-%Y') AS issue_text,
            a.paid_days, a.basic, a.hra, a.da, a.conveyance_allowance, a.overtime,
            a.pf_deduction, a.esi_deduction, a.pt_deduction, a.tds_deduction, a.other_deduction,
            a.establishment_id, e.employee_id AS emp_code, e.establishment_id AS current_establishment_id,
            es.name AS establishment_name
     FROM arrear_data a
     JOIN employees e ON e.id = a.employee_id
     JOIN establishments es ON es.id = a.establishment_id
     WHERE a.establishment_id = ? AND a.arrear_from_month = ? AND a.arrear_from_year = ?
       AND a.arrear_to_month = ? AND a.arrear_to_year = ?
     ORDER BY e.full_name`,
    [establishment_id, month, year, to_month, to_year]
  );
  if (!rows.length) return res.status(404).json({ message: 'No arrear records found for this establishment and period' });

  const n = (v) => Number(v) || 0;
  const dataRows = rows.map((r) => [
    r.emp_code, r.arrear_from_month, r.arrear_from_year, r.arrear_to_month, r.arrear_to_year, r.issue_text || '',
    n(r.paid_days), n(r.basic), n(r.hra), n(r.da), n(r.conveyance_allowance), n(r.overtime),
    n(r.pf_deduction), n(r.esi_deduction), n(r.pt_deduction), n(r.tds_deduction), n(r.other_deduction),
    r.current_establishment_id !== r.establishment_id
      ? 'Moved to another establishment since this period - edit on screen, do not re-import this row'
      : ''
  ]);
  const safeName = String(rows[0].establishment_name).replace(/[^A-Za-z0-9._-]+/g, '_');
  const p2 = (v) => String(v).padStart(2, '0');
  const fileName = `arrear-data_${safeName}_${rows[0].arrear_from_year}-${p2(rows[0].arrear_from_month)}_to_${rows[0].arrear_to_year}-${p2(rows[0].arrear_to_month)}.xlsx`;
  await sendDataExport(res, fileName, [...TEMPLATE_HEADERS, 'note'], dataRows);
});

// ---- Viewing ---------------------------------------------------------------
const LIST_SQL = `
  SELECT a.id, a.establishment_id, a.employee_id, a.arrear_from_month, a.arrear_from_year, a.arrear_to_month, a.arrear_to_year,
         DATE_FORMAT(a.date_of_issue, '%d-%m-%Y') AS date_of_issue_text,
         a.paid_days, a.basic, a.hra, a.da, a.conveyance_allowance, a.overtime, a.gross_earnings,
         a.pf_deduction, a.esi_deduction, a.pt_deduction, a.tds_deduction, a.other_deduction,
         a.total_deduction, a.net_pay, a.uploaded_at,
         e.employee_id AS emp_code, e.full_name, es.name AS establishment_name
  FROM arrear_data a
  JOIN employees e ON e.id = a.employee_id
  JOIN establishments es ON es.id = a.establishment_id`;

// One row per establishment per arrear period.
router.get('/summary', requirePermission('upload_salary', 'view'), async (req, res) => {
  const { establishment_id, month, year, to_month, to_year } = req.query;
  const clauses = [];
  const params = [];
  if (establishment_id) { clauses.push('a.establishment_id = ?'); params.push(establishment_id); }
  if (month) { clauses.push('a.arrear_from_month = ?'); params.push(month); }
  if (year) { clauses.push('a.arrear_from_year = ?'); params.push(year); }
  if (to_month) { clauses.push('a.arrear_to_month = ?'); params.push(to_month); }
  if (to_year) { clauses.push('a.arrear_to_year = ?'); params.push(to_year); }
  addScope(req, clauses, params, 'a.establishment_id');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT es.name AS establishment_name, a.establishment_id,
            a.arrear_from_month, a.arrear_from_year, a.arrear_to_month, a.arrear_to_year,
            COUNT(a.id) AS record_count, SUM(a.net_pay) AS total_net_pay
     FROM arrear_data a JOIN establishments es ON es.id = a.establishment_id
     ${where}
     GROUP BY a.establishment_id, a.arrear_from_year, a.arrear_from_month, a.arrear_to_year, a.arrear_to_month, es.name
     ORDER BY a.arrear_from_year DESC, a.arrear_from_month DESC, a.arrear_to_year DESC, a.arrear_to_month DESC, es.name`,
    params
  );
  res.json(rows);
});

router.get('/', requirePermission('upload_salary', 'view'), async (req, res) => {
  const { establishment_id, month, year, to_month, to_year, search } = req.query;
  const clauses = [];
  const params = [];
  if (establishment_id) { clauses.push('a.establishment_id = ?'); params.push(establishment_id); }
  if (month) { clauses.push('a.arrear_from_month = ?'); params.push(month); }
  if (year) { clauses.push('a.arrear_from_year = ?'); params.push(year); }
  if (to_month) { clauses.push('a.arrear_to_month = ?'); params.push(to_month); }
  if (to_year) { clauses.push('a.arrear_to_year = ?'); params.push(to_year); }
  if (search) { clauses.push('(e.employee_id LIKE ? OR e.full_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  addScope(req, clauses, params, 'a.establishment_id');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `${LIST_SQL} ${where} ORDER BY a.arrear_from_year DESC, a.arrear_from_month DESC, a.arrear_to_year DESC, a.arrear_to_month DESC, e.full_name, a.arrear_from_year, a.arrear_from_month, a.arrear_to_year, a.arrear_to_month`, params
  );
  res.json(rows);
});

// ---- Single record -----------------------------------------------------------
async function applyCreateArrear(b, uploadedBy) {
  const overlap = await findOverlappingArrear(pool, b.employee_id, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year);
  if (overlap) throw new Error(overlapMessage(overlap));
  const totals = computeTotals(b);
  const snapshot = await captureSlipSnapshot(b.employee_id, b.establishment_id, b.arrear_to_month, b.arrear_to_year);
  const [result] = await pool.query(
    `INSERT INTO arrear_data
      (establishment_id, employee_id, arrear_from_month, arrear_from_year, arrear_to_month, arrear_to_year, date_of_issue, paid_days,
       basic, hra, da, conveyance_allowance, overtime, gross_earnings, pf_deduction, esi_deduction,
       pt_deduction, tds_deduction, other_deduction, total_deduction, net_pay, uploaded_by, slip_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [b.establishment_id, b.employee_id, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year, b.date_of_issue, b.paid_days || 0,
     b.basic || 0, b.hra || 0, b.da || 0, b.conveyance_allowance || 0, b.overtime || 0, totals.gross_earnings,
     b.pf_deduction || 0, b.esi_deduction || 0, b.pt_deduction || 0, b.tds_deduction || 0, b.other_deduction || 0,
     totals.total_deduction, totals.net_pay, uploadedBy, snapshot]
  );
  return { id: result.insertId };
}

router.post('/', requirePermission('upload_salary', 'edit'), async (req, res) => {
  const b = req.body;
  if (!b.establishment_id || !b.employee_id || !b.arrear_from_month || !b.arrear_from_year || !b.arrear_to_month || !b.arrear_to_year) {
    return res.status(400).json({ message: 'Establishment, employee and arrear period (from and to) are required' });
  }
  if (!allowEstablishment(req, res, b.establishment_id)) return;
  if (!(await allowRecords(req, res, 'employees', [b.employee_id]))) return;
  const periodError = validatePeriods(b);
  if (periodError) return res.status(400).json({ message: periodError });
  const issueDate = parseIssueDate(b.date_of_issue);
  if (!issueDate) return res.status(400).json({ message: DATE_HELP });
  b.date_of_issue = issueDate;
  const filledError = checkFigures((name) => b[name], FIGURE_COLUMNS, { mustBePositive: ['basic'] });
  if (filledError) return res.status(400).json({ message: filledError });
  const figuresError = validateFigures((name) => b[name] || 0, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year);
  if (figuresError) return res.status(400).json({ message: figuresError });

  {
    const [[win]] = await pool.query(`${EMP_WINDOW_SQL} WHERE id = ?`, [b.employee_id]);
    const windowError = win ? arrearWindowError(win, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year, `Employee ${win.employee_id}`, b.date_of_issue) : null;
    if (windowError) return res.status(400).json({ message: windowError });
  }
  const overlap = await findOverlappingArrear(pool, b.employee_id, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year);
  if (overlap) return res.status(409).json({ message: overlapMessage(overlap) });

  const label = `employee ${await employeeLabel(b.employee_id)}, arrear ${b.arrear_from_month}/${b.arrear_from_year} to ${b.arrear_to_month}/${b.arrear_to_year}`;
  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'upload_salary', action: 'ARREAR_CREATE', payload: b,
      description: cut(`Add arrear record for employee ${await employeeLabel(b.employee_id)}, arrear ${b.arrear_from_month}/${b.arrear_from_year} to ${b.arrear_to_month}/${b.arrear_to_year}`)
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    const result = await applyCreateArrear(b, req.user.id);
    res.status(201).json({ id: result.id });
    await logActivity(req, 'CREATE', 'upload_salary', `Added arrear record for ${label}`, Number(b.establishment_id));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'An arrear record for this employee and arrear period already exists. Delete it first, or upload the corrected row through Import from Excel (which updates it).' });
    }
    throw err;
  }
});

// ---- Edit one record ------------------------------------------------------------
// Changes the arrear period, date of issue and figures of an existing record.
// The employee and establishment of a record never change (delete it and add
// a new one for that). Gross, total deduction and net pay are recalculated.
// The employee/establishment details printed on the slip are frozen when the
// record is created, so an edit leaves them alone - except when the arrear
// "to" month changes, which re-freezes them as they were in that month.
async function applyUpdateArrear(id, b) {
  const [[existing]] = await pool.query('SELECT * FROM arrear_data WHERE id = ?', [id]);
  if (!existing) { const err = new Error('Arrear record not found'); err.status = 404; throw err; }
  const overlap = await findOverlappingArrear(pool, existing.employee_id, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year, { excludeId: id });
  if (overlap) throw new Error(overlapMessage(overlap));
  const totals = computeTotals(b);
  const toChanged = Number(existing.arrear_to_month) !== Number(b.arrear_to_month) || Number(existing.arrear_to_year) !== Number(b.arrear_to_year);
  const snapshot = toChanged
    ? await captureSlipSnapshot(existing.employee_id, existing.establishment_id, b.arrear_to_month, b.arrear_to_year)
    : null;
  await pool.query(
    `UPDATE arrear_data SET arrear_from_month=?, arrear_from_year=?, arrear_to_month=?, arrear_to_year=?, date_of_issue=?, paid_days=?,
       basic=?, hra=?, da=?, conveyance_allowance=?, overtime=?, gross_earnings=?, pf_deduction=?, esi_deduction=?,
       pt_deduction=?, tds_deduction=?, other_deduction=?, total_deduction=?, net_pay=?
       ${toChanged ? ', slip_snapshot=?' : ''}
     WHERE id=?`,
    [b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year, b.date_of_issue, b.paid_days || 0,
     b.basic || 0, b.hra || 0, b.da || 0, b.conveyance_allowance || 0, b.overtime || 0, totals.gross_earnings,
     b.pf_deduction || 0, b.esi_deduction || 0, b.pt_deduction || 0, b.tds_deduction || 0, b.other_deduction || 0,
     totals.total_deduction, totals.net_pay,
     ...(toChanged ? [snapshot] : []), id]
  );
  return {};
}

router.put('/:id', requirePermission('upload_salary', 'edit'), async (req, res) => {
  const [[existing]] = await pool.query(
    'SELECT id, establishment_id, employee_id FROM arrear_data WHERE id = ?', [req.params.id]
  );
  if (!existing) return res.status(404).json({ message: 'Arrear record not found' });
  if (!allowEstablishment(req, res, existing.establishment_id)) return;

  const b = req.body;
  const periodError = validatePeriods(b);
  if (periodError) return res.status(400).json({ message: periodError });
  const issueDate = parseIssueDate(b.date_of_issue);
  if (!issueDate) return res.status(400).json({ message: DATE_HELP });
  b.date_of_issue = issueDate;
  const filledError = checkFigures((name) => b[name], FIGURE_COLUMNS, { mustBePositive: ['basic'] });
  if (filledError) return res.status(400).json({ message: filledError });
  const figuresError = validateFigures((name) => b[name] || 0, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year);
  if (figuresError) return res.status(400).json({ message: figuresError });

  {
    const [[win]] = await pool.query(`${EMP_WINDOW_SQL} WHERE id = ?`, [existing.employee_id]);
    const windowError = win ? arrearWindowError(win, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year, `Employee ${win.employee_id}`, b.date_of_issue) : null;
    if (windowError) return res.status(400).json({ message: windowError });
  }
  const overlap = await findOverlappingArrear(pool, existing.employee_id, b.arrear_from_month, b.arrear_from_year, b.arrear_to_month, b.arrear_to_year, { excludeId: req.params.id });
  if (overlap) return res.status(409).json({ message: overlapMessage(overlap) });

  const label = `arrear record ID ${req.params.id} (arrear ${b.arrear_from_month}/${b.arrear_from_year} to ${b.arrear_to_month}/${b.arrear_to_year})`;
  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'upload_salary', action: 'ARREAR_UPDATE', targetId: req.params.id, payload: b,
      description: cut(`Edit arrear record of employee ${await arrearRecordLabel(req.params.id)}, arrear ${b.arrear_from_month}/${b.arrear_from_year} to ${b.arrear_to_month}/${b.arrear_to_year}`)
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    await applyUpdateArrear(req.params.id, b);
    res.json({ message: 'Arrear record updated' });
    await logActivity(req, 'UPDATE', 'upload_salary', `Updated ${label}`, existing.establishment_id);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Another arrear record for this employee and arrear period already exists.' });
    }
    throw err;
  }
});

// ---- Delete --------------------------------------------------------------------
async function applyDeleteArrears(ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return { deleted: 0 };
  const [result] = await pool.query('DELETE FROM arrear_data WHERE id IN (?)', [list]);
  return { deleted: result.affectedRows };
}

router.delete('/records', requirePermission('upload_salary', 'delete'), async (req, res) => {
  const raw = Array.isArray(req.body.ids) ? req.body.ids : [];
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.status(400).json({ message: 'No arrear records selected' });
  if (ids.length > DELETE_MAX) return res.status(400).json({ message: `Too many records selected (limit ${DELETE_MAX})` });
  const [found] = await pool.query('SELECT id FROM arrear_data WHERE id IN (?)', [ids]);
  if (found.length !== ids.length) {
    return res.status(404).json({ message: 'Some of the selected arrear records no longer exist. Refresh and try again.' });
  }
  if (!(await allowRecords(req, res, 'arrear_data', ids))) return;

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'upload_salary', action: 'ARREAR_DELETE', payload: { ids },
      description: cut(`Delete ${ids.length} arrear record(s) of employee(s) ${await recordEmployeesText('arrear_data', ids)}`)
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const result = await applyDeleteArrears(ids);
  res.json({ message: `${result.deleted} arrear record(s) deleted`, deleted: result.deleted });
  if (result.deleted) await logActivity(req, 'DELETE', 'upload_salary', `Deleted ${result.deleted} arrear record(s) (IDs ${ids.slice(0, 50).join(', ')}${ids.length > 50 ? ', ...' : ''})`);
});

// ---- Excel import ----------------------------------------------------------------
async function processArrearImportRows(conn, sheet, colIndex, results, reportProgress, isCancelled, uploadedById) {
  for (let r = 2; r <= sheet.rowCount; r++) {
    if (isCancelled()) break;
    reportProgress();
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const employeeCode = row.getCell(colIndex('employee_id')).value;
    if (!employeeCode) continue;

    try {
      const [[emp]] = await conn.query('SELECT id, establishment_id FROM employees WHERE employee_id = ?', [String(employeeCode).trim()]);
      if (!emp) {
        results.errors.push(`Row ${r}: employee_id "${employeeCode}" not found`);
        results.skipped++;
        continue;
      }
      const get = (name) => Number(row.getCell(colIndex(name)).value);
      const b = {};
      FIGURE_COLUMNS.forEach((n) => { b[n] = get(n); });
      const totals = computeTotals(b);
      const fromMonth = get('arrear_from_month');
      const fromYear = get('arrear_from_year');
      const toMonth = get('arrear_to_month');
      const toYear = get('arrear_to_year');
      const issueDate = parseIssueDate(row.getCell(colIndex('date_of_issue')).value);
      if (!issueDate) {
        results.errors.push(`Row ${r}: ${DATE_HELP}`);
        results.skipped++;
        continue;
      }
      const overlap = await findOverlappingArrear(conn, emp.id, fromMonth, fromYear, toMonth, toYear, { sameRangeIsOk: true });
      if (overlap) throw new OverlapError(`Row ${r}: employee "${employeeCode}" ${periodLabel(fromMonth, fromYear, toMonth, toYear)} overlaps an existing arrear record (${periodLabel(overlap.arrear_from_month, overlap.arrear_from_year, overlap.arrear_to_month, overlap.arrear_to_year)}) - nothing was imported`);
      const snapshot = await captureSlipSnapshot(emp.id, emp.establishment_id, toMonth, toYear, conn);

      await conn.query(
        `INSERT INTO arrear_data
          (establishment_id, employee_id, arrear_from_month, arrear_from_year, arrear_to_month, arrear_to_year, date_of_issue, paid_days,
           basic, hra, da, conveyance_allowance, overtime, gross_earnings, pf_deduction, esi_deduction,
           pt_deduction, tds_deduction, other_deduction, total_deduction, net_pay, uploaded_by, slip_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           date_of_issue=VALUES(date_of_issue), paid_days=VALUES(paid_days), basic=VALUES(basic), hra=VALUES(hra), da=VALUES(da),
           conveyance_allowance=VALUES(conveyance_allowance), overtime=VALUES(overtime),
           gross_earnings=VALUES(gross_earnings), pf_deduction=VALUES(pf_deduction),
           esi_deduction=VALUES(esi_deduction), pt_deduction=VALUES(pt_deduction),
           tds_deduction=VALUES(tds_deduction), other_deduction=VALUES(other_deduction),
           total_deduction=VALUES(total_deduction), net_pay=VALUES(net_pay)`,
        [emp.establishment_id, emp.id, fromMonth, fromYear, toMonth, toYear, issueDate, b.paid_days,
         b.basic, b.hra, b.da, b.conveyance_allowance, b.overtime, totals.gross_earnings, b.pf_deduction,
         b.esi_deduction, b.pt_deduction, b.tds_deduction, b.other_deduction, totals.total_deduction,
         totals.net_pay, uploadedById, snapshot]
      );
      results.inserted++;
    } catch (err) {
      if (err instanceof OverlapError) throw err;
      results.errors.push(`Row ${r}: ${err.message}`);
      results.skipped++;
    }
  }
}

async function applyImportArrear(filePath, uploadedById) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const header = sheet.getRow(1).values.map((v) => (v || '').toString().trim().toLowerCase());
  const colIndex = (name) => header.indexOf(name);
  const results = { inserted: 0, skipped: 0, errors: [] };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await processArrearImportRows(conn, sheet, colIndex, results, () => {}, () => false, uploadedById);
    await conn.commit();
    return results;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

router.post(
  '/import',
  requirePermission('upload_salary', 'edit'),
  excelImport.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Excel file is required' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values.map((v) => (v || '').toString().trim().toLowerCase());
    const colIndex = (name) => header.indexOf(name);

    // Whole upload refused up front if any required cell is blank/non-numeric,
    // a period is invalid, or the figures are inconsistent - nothing is saved.
    const nullProblems = findNullCellProblems(
      sheet, colIndex, TEMPLATE_HEADERS, TEMPLATE_HEADERS.filter((name) => name !== 'employee_id' && name !== 'date_of_issue'),
      (row, ci) => {
        const val = (name) => row.getCell(ci(name)).value;
        const periodError = validatePeriods({
          arrear_from_month: val('arrear_from_month'), arrear_from_year: val('arrear_from_year'),
          arrear_to_month: val('arrear_to_month'), arrear_to_year: val('arrear_to_year')
        });
        if (periodError) return periodError;
        if (!parseIssueDate(val('date_of_issue'))) return DATE_HELP;
        const figureError = checkFigures(val, FIGURE_COLUMNS, { mustBePositive: ['basic'] });
        if (figureError) return figureError;
        return validateFigures(val, val('arrear_from_month'), val('arrear_from_year'), val('arrear_to_month'), val('arrear_to_year'));
      }
    );
    const allProblems = [...nullProblems, ...findDuplicatesInSheet(sheet, colIndex)];
    if (!allProblems.length) allProblems.push(...await findArrearWindowProblems(sheet, colIndex));
    if (!allProblems.length) allProblems.push(...await findOverlapProblems(sheet, colIndex));
    if (allProblems.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: nullCellErrorMessage(allProblems) });
    }
    const scopeProblems = await findEstablishmentScopeProblems(req, sheet, colIndex);
    if (scopeProblems.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ message: nullCellErrorMessage(scopeProblems) });
    }

    if (!isAdminUser(req)) {
      const rowCount = Math.max(0, sheet.rowCount - 1);
      await createApprovalRequest({
        req, moduleKey: 'upload_salary', action: 'ARREAR_IMPORT', stagedFilePath: req.file.path,
        description: `Bulk import ${rowCount} arrear salary row(s)`
      });
      return res.status(202).json({ message: 'Submitted for approval, pending.' });
    }

    const results = { inserted: 0, skipped: 0, errors: [] };
    const totalRows = Math.max(0, sheet.rowCount - 1);
    const conn = await pool.getConnection();
    let cancelled = false;
    let reportProgress, sendDone, sendError;
    const onClose = () => { if (!res.writableEnded) cancelled = true; };
    req.on('close', onClose);

    try {
      await conn.beginTransaction();
      const progress = startImportProgress(res, totalRows);
      ({ reportProgress, sendDone } = progress);
      sendError = progress.sendError;

      await processArrearImportRows(conn, sheet, colIndex, results, reportProgress, () => cancelled, req.user.id);

      if (cancelled) {
        await conn.rollback();
      } else {
        await conn.commit();
        sendDone(results);
        await logActivity(req, 'IMPORT', 'upload_salary', `Imported arrear salary data: ${results.inserted} record(s), ${results.skipped} skipped`);
      }
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* connection may already be broken */ }
      if (!cancelled) {
        if (sendError) {
          console.error(err);
          sendError(err.message || 'Import failed due to an unexpected server error.');
        } else {
          throw err;
        }
      }
    } finally {
      req.removeListener('close', onClose);
      conn.release();
      fs.unlink(req.file.path, () => {});
    }
  }
);

// Called (through routes/salaryData.js) when an Admin approves a pending
// arrear request.
async function applyApprovedArrearAction(action, targetId, payload, requestedBy, stagedFilePath) {
  switch (action) {
    case 'ARREAR_CREATE':
      return applyCreateArrear(payload, requestedBy);
    case 'ARREAR_UPDATE':
      return applyUpdateArrear(targetId, payload);
    case 'ARREAR_DELETE':
      return applyDeleteArrears(payload.ids);
    case 'ARREAR_IMPORT':
      return applyImportArrear(stagedFilePath, requestedBy);
    default:
      throw new Error(`Unknown action "${action}" for arrear data`);
  }
}

module.exports = router;
module.exports.applyApprovedAction = applyApprovedArrearAction;
