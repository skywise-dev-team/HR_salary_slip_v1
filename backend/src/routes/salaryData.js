const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const ExcelJS = require('exceljs');
const fs = require('fs');
const pool = require('../config/db');
const { requireAuth, requirePermission, requireNotPendingPasswordChange } = require('../middleware/auth');
const { excelImport } = require('../middleware/upload');
const { captureSlipSnapshot } = require('../utils/slipService');
const { startImportProgress } = require('../utils/importProgress');
const { findNullCellProblems, nullCellErrorMessage } = require('../utils/nullCellCheck');
const { sendTemplate } = require('../utils/excelTemplates');
const { logActivity } = require('../utils/activityLog');
const { isAdminUser, createApprovalRequest } = require('../utils/approvals');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

const TEMPLATE_HEADERS = [
  'employee_id', 'period_month', 'period_year', 'paid_days', 'basic', 'hra', 'da',
  'conveyance_allowance', 'overtime', 'pf_deduction', 'esi_deduction', 'pt_deduction',
  'tds_deduction', 'other_deduction'
];
const TEMPLATE_EXAMPLE = ['11005001', 6, 2026, 26, 23456, 1245, 1400, 0, 0, 1800, 230, 130, 0, 0];

const EARNINGS_COLUMNS = ['basic', 'da', 'hra', 'conveyance_allowance', 'overtime'];
const DEDUCTION_COLUMNS = ['pf_deduction', 'esi_deduction', 'pt_deduction', 'tds_deduction', 'other_deduction'];

// period_month must be an integer 1-12; period_year must be a proper 4-digit
// "yyyy" value — neither blank/0 (already caught elsewhere as a blank cell)
// nor a garbage or out-of-range number like month=13 or a 2-digit year.
function validatePeriod(monthRaw, yearRaw) {
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return `period_month must be between 1 and 12 (got "${monthRaw}")`;
  }
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    return `period_year must be a 4-digit year, e.g. 2026 (got "${yearRaw}")`;
  }
  return null;
}

// A period's month always has a fixed, known number of days —
// new Date(year, month, 0) lands on the last day of the given 1-indexed
// month, correctly accounting for leap years.
function daysInMonth(month, year) {
  return new Date(year, month, 0).getDate();
}

// Checks a row's actual payroll figures for internal consistency.
// `getValue(name)` should return the already-validated numeric value for
// that column. periodMonth/periodYear are optional — when given, paid_days
// is also checked against that period's actual day count.
//
// This replaced an earlier "every earnings and deduction figure is zero"
// rule — an employee absent for the entire period (paid_days = 0, every
// earning and deduction also 0) is a legitimate record, not a data-entry
// mistake, so that's no longer checked at all. Negative figures are also
// allowed (e.g. a correction or adjustment), so nothing here rejects those
// either. What's actually checked:
//   - DA, HRA, and Conveyance Allowance each stay within Basic Pay
//   - total deductions never exceed gross earnings, since that would make
//     net pay negative — not a real outcome for an actual salary slip
//   - paid_days never exceeds how many days that period's month actually has
function validateSalaryFigures(getValue, periodMonth, periodYear) {
  const num = (name) => Number(getValue(name)) || 0;

  const basic = num('basic');
  for (const name of ['da', 'hra', 'conveyance_allowance']) {
    if (num(name) > basic) {
      return `${name} (${num(name)}) cannot be greater than basic pay (${basic})`;
    }
  }

  const gross = EARNINGS_COLUMNS.reduce((sum, name) => sum + num(name), 0);
  const totalDeduction = DEDUCTION_COLUMNS.reduce((sum, name) => sum + num(name), 0);
  if (totalDeduction > gross) {
    return `total deductions (${totalDeduction}) cannot be greater than gross earnings (${gross}) — this would make net pay negative`;
  }

  if (periodMonth != null && periodYear != null) {
    const maxDays = daysInMonth(Number(periodMonth), Number(periodYear));
    if (num('paid_days') > maxDays) {
      return `paid_days (${num('paid_days')}) cannot exceed the number of days in this period's month (${maxDays})`;
    }
  }

  return null;
}

// Detects the SAME (employee_id, period_month, period_year) combination
// appearing more than once within one uploaded file — e.g. the same
// employee's April 2026 row listed twice by mistake. Without this check,
// the second occurrence would silently overwrite the first via
// "ON DUPLICATE KEY UPDATE" during the actual import, with no warning that
// anything was overwritten and no way to tell which of the two versions
// "won". This is checked purely by reading the parsed sheet in memory,
// before any database call is made, so it behaves identically regardless
// of the database's own primary-key/index structure for salary_data —
// whether that's the simple `id` primary key in schema.sql, or an existing
// live database's composite primary key on
// (establishment_id, employee_id, period_month, period_year). Either way,
// this in-file duplicate can never even reach the database to be silently
// merged.
function findDuplicatePeriodsInSheet(sheet, colIndex) {
  const seen = new Map(); // "employeeId|month|year" -> [row numbers]
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const empRaw = row.getCell(colIndex('employee_id')).value;
    const monthRaw = row.getCell(colIndex('period_month')).value;
    const yearRaw = row.getCell(colIndex('period_year')).value;
    // A blank/invalid employee_id, month, or year is already reported by
    // the null-cell and period checks — skip here to avoid a confusing
    // second complaint about the same missing value.
    if (empRaw == null || String(empRaw).trim() === '') continue;
    if (monthRaw == null || String(monthRaw).trim() === '') continue;
    if (yearRaw == null || String(yearRaw).trim() === '') continue;

    const key = `${String(empRaw).trim()}|${Number(monthRaw)}|${Number(yearRaw)}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(r);
  }

  const problems = [];
  for (const [key, rows] of seen.entries()) {
    if (rows.length > 1) {
      const [empId, month, year] = key.split('|');
      problems.push(
        `Duplicate entry: employee_id "${empId}" for period ${month}/${year} appears in rows ${rows.join(', ')} — ` +
        `only one row per employee per period is allowed in a single upload`
      );
    }
  }
  return problems;
}

router.get('/template', requirePermission('upload_salary', 'edit'), async (req, res) => {
  await sendTemplate(res, 'salary-data-template.xlsx', TEMPLATE_HEADERS, TEMPLATE_EXAMPLE);
});

const LIST_SQL = `
  SELECT sd.id, sd.establishment_id, sd.employee_id, sd.period_month, sd.period_year,
         sd.paid_days, sd.basic, sd.hra, sd.da, sd.conveyance_allowance, sd.overtime,
         sd.gross_earnings, sd.pf_deduction, sd.esi_deduction, sd.pt_deduction,
         sd.tds_deduction, sd.other_deduction, sd.total_deduction, sd.net_pay,
         sd.uploaded_by, sd.uploaded_at,
         e.employee_id AS emp_code, e.full_name, es.name AS establishment_name
  FROM salary_data sd
  JOIN employees e ON e.id = sd.employee_id
  JOIN establishments es ON es.id = sd.establishment_id`;

router.get('/', requirePermission('upload_salary', 'view'), async (req, res) => {
  const { establishment_id, month, year, search } = req.query;
  const clauses = [];
  const params = [];

  if (establishment_id) { clauses.push('sd.establishment_id = ?'); params.push(establishment_id); }
  if (month) { clauses.push('sd.period_month = ?'); params.push(month); }
  if (year) { clauses.push('sd.period_year = ?'); params.push(year); }
  if (search) { clauses.push('(e.employee_id LIKE ? OR e.full_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(`${LIST_SQL} ${where} ORDER BY sd.period_year DESC, sd.period_month DESC`, params);
  res.json(rows);
});

// Grouped view for the Upload Salary Data page — one row per establishment
// per pay period, with a count of how many salary records exist for that
// group and the sum of their net pay. Per-employee detail lives on the
// Salary Slips page instead, so this deliberately doesn't return individual
// employee rows.
router.get('/summary', requirePermission('upload_salary', 'view'), async (req, res) => {
  const { establishment_id, month, year } = req.query;
  const clauses = [];
  const params = [];

  if (establishment_id) { clauses.push('sd.establishment_id = ?'); params.push(establishment_id); }
  if (month) { clauses.push('sd.period_month = ?'); params.push(month); }
  if (year) { clauses.push('sd.period_year = ?'); params.push(year); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT es.name AS establishment_name, sd.establishment_id, sd.period_month, sd.period_year,
            COUNT(sd.id) AS slip_count, SUM(sd.net_pay) AS total_net_pay
     FROM salary_data sd
     JOIN establishments es ON es.id = sd.establishment_id
     ${where}
     GROUP BY sd.establishment_id, sd.period_month, sd.period_year, es.name
     ORDER BY sd.period_year DESC, sd.period_month DESC, es.name`,
    params
  );
  res.json(rows);
});

function computeTotals(body) {
  const num = (v) => Number(v) || 0;
  const gross = num(body.basic) + num(body.hra) + num(body.da) + num(body.conveyance_allowance) + num(body.overtime);
  const totalDed = num(body.pf_deduction) + num(body.esi_deduction) + num(body.pt_deduction) + num(body.tds_deduction) + num(body.other_deduction);
  return {
    gross_earnings: body.gross_earnings != null ? num(body.gross_earnings) : gross,
    total_deduction: body.total_deduction != null ? num(body.total_deduction) : totalDed,
    net_pay: body.net_pay != null ? num(body.net_pay) : gross - totalDed
  };
}

// Deletes every salary_data row for one or more establishment+period
// groups — i.e. entire rows from the Upload Salary Data summary table.
async function applyDeleteGroups(groups) {
  const clauses = groups.map(() => '(establishment_id = ? AND period_month = ? AND period_year = ?)');
  const params = groups.flatMap((g) => [g.establishment_id, g.period_month, g.period_year]);
  const where = clauses.join(' OR ');
  const [result] = await pool.query(`DELETE FROM salary_data WHERE ${where}`, params);
  return { deleted: result.affectedRows };
}

router.delete('/groups', requirePermission('upload_salary', 'delete'), async (req, res) => {
  const { groups } = req.body;
  if (!Array.isArray(groups) || !groups.length) {
    return res.status(400).json({ message: 'No establishment/period groups selected' });
  }

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'upload_salary', action: 'BULK_DELETE', payload: { groups },
      description: `Delete ${groups.length} establishment/period group(s) of salary records`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  const result = await applyDeleteGroups(groups);
  res.json({ message: `${result.deleted} salary record(s) deleted`, deleted: result.deleted });
  if (result.deleted) await logActivity(req, 'DELETE', 'upload_salary', `Deleted ${result.deleted} salary record(s) across ${groups.length} establishment/period group(s)`);
});

// Applies a new salary record directly, generating its slip immediately
// after. `uploadedBy` is recorded as whoever actually entered the figures —
// the original requester when this runs via an approved request, not the
// Admin who approved it.
async function applyCreateSalaryData(b, uploadedBy) {
  const totals = computeTotals(b);
  const slipSnapshot = await captureSlipSnapshot(b.employee_id, b.establishment_id);
  const [result] = await pool.query(
    `INSERT INTO salary_data
      (establishment_id, employee_id, period_month, period_year, paid_days, basic, hra, da,
       conveyance_allowance, overtime, gross_earnings, pf_deduction, esi_deduction, pt_deduction,
       tds_deduction, other_deduction, total_deduction, net_pay, uploaded_by, slip_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [b.establishment_id, b.employee_id, b.period_month, b.period_year, b.paid_days || 0,
     b.basic || 0, b.hra || 0, b.da || 0, b.conveyance_allowance || 0, b.overtime || 0,
     totals.gross_earnings, b.pf_deduction || 0, b.esi_deduction || 0, b.pt_deduction || 0,
     b.tds_deduction || 0, b.other_deduction || 0, totals.total_deduction, totals.net_pay, uploadedBy, slipSnapshot]
  );

  return { id: result.insertId };
}

router.post('/', requirePermission('upload_salary', 'edit'), async (req, res) => {
  const b = req.body;
  if (!b.establishment_id || !b.employee_id || !b.period_month || !b.period_year) {
    return res.status(400).json({ message: 'Establishment, employee and period are required' });
  }
  const periodError = validatePeriod(b.period_month, b.period_year);
  if (periodError) return res.status(400).json({ message: periodError });
  const figuresError = validateSalaryFigures((name) => b[name] || 0, b.period_month, b.period_year);
  if (figuresError) return res.status(400).json({ message: figuresError });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'upload_salary', action: 'CREATE', payload: b,
      description: `Add salary record for employee ID ${b.employee_id}, period ${b.period_month}/${b.period_year}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  try {
    const result = await applyCreateSalaryData(b, req.user.id);
    res.status(201).json({ id: result.id });
    await logActivity(req, 'CREATE', 'upload_salary', `Added salary record for employee ID ${b.employee_id}, period ${b.period_month}/${b.period_year}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A record for this employee and period already exists' });
    }
    throw err;
  }
});

// Applies an edit to an existing salary record directly. Deliberately never
// touches slip_snapshot — that's captured once, at creation, and frozen
// from then on, exactly so an edit here (or a later employee/establishment
// change) can never retroactively alter an already-issued slip's
// designation, bank account, address, signatory name, etc.
async function applyUpdateSalaryData(id, b) {
  const totals = computeTotals(b);
  await pool.query(
    `UPDATE salary_data SET paid_days=?, basic=?, hra=?, da=?, conveyance_allowance=?, overtime=?,
       gross_earnings=?, pf_deduction=?, esi_deduction=?, pt_deduction=?, tds_deduction=?,
       other_deduction=?, total_deduction=?, net_pay=?, downloaded=0
     WHERE id=?`,
    [b.paid_days || 0, b.basic || 0, b.hra || 0, b.da || 0, b.conveyance_allowance || 0, b.overtime || 0,
     totals.gross_earnings, b.pf_deduction || 0, b.esi_deduction || 0, b.pt_deduction || 0,
     b.tds_deduction || 0, b.other_deduction || 0, totals.total_deduction, totals.net_pay, id]
  );
  return {};
}

router.put('/:id', requirePermission('upload_salary', 'edit'), async (req, res) => {
  const [[existing]] = await pool.query('SELECT id, period_month, period_year FROM salary_data WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'Salary record not found' });

  const figuresError = validateSalaryFigures((name) => req.body[name] || 0, existing.period_month, existing.period_year);
  if (figuresError) return res.status(400).json({ message: figuresError });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'upload_salary', action: 'UPDATE', targetId: req.params.id, payload: req.body,
      description: `Edit salary record ID ${req.params.id}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  await applyUpdateSalaryData(req.params.id, req.body);
  res.json({ message: 'Salary record updated' });
  await logActivity(req, 'UPDATE', 'upload_salary', `Updated salary record ID ${req.params.id}`);
});

async function applyDeleteSalaryData(id) {
  await pool.query('DELETE FROM salary_data WHERE id = ?', [id]);
  return {};
}

router.delete('/:id', requirePermission('upload_salary', 'delete'), async (req, res) => {
  const [[existing]] = await pool.query('SELECT id FROM salary_data WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'Salary record not found' });

  if (!isAdminUser(req)) {
    await createApprovalRequest({
      req, moduleKey: 'upload_salary', action: 'DELETE', targetId: req.params.id,
      description: `Delete salary record ID ${req.params.id}`
    });
    return res.status(202).json({ message: 'Submitted for approval, pending.' });
  }

  await applyDeleteSalaryData(req.params.id);
  res.json({ message: 'Salary record deleted' });
  await logActivity(req, 'DELETE', 'upload_salary', `Deleted salary record ID ${req.params.id}`);
});

// Shared by the direct-upload path (Admin, streamed) and the
// approval-triggered path (everyone else, applied later, no streaming).
async function processSalaryDataImportRows(conn, sheet, colIndex, results, reportProgress, isCancelled, uploadedById) {
  for (let r = 2; r <= sheet.rowCount; r++) {
    if (isCancelled()) break;
    reportProgress();
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;

    const employeeCode = row.getCell(colIndex('employee_id')).value;
    if (!employeeCode) continue;

    try {
      const [[emp]] = await conn.query(
        'SELECT id, establishment_id FROM employees WHERE employee_id = ?',
        [String(employeeCode).trim()]
      );
      if (!emp) {
        results.errors.push(`Row ${r}: employee_id "${employeeCode}" not found`);
        results.skipped++;
        continue;
      }

      const get = (name) => Number(row.getCell(colIndex(name)).value);

      const basic = get('basic');
      const hra = get('hra');
      const da = get('da');
      const conveyance = get('conveyance_allowance');
      const overtime = get('overtime');
      const pf = get('pf_deduction');
      const esi = get('esi_deduction');
      const pt = get('pt_deduction');
      const tds = get('tds_deduction');
      const otherDed = get('other_deduction');
      const gross = basic + hra + da + conveyance + overtime;
      const totalDed = pf + esi + pt + tds + otherDed;
      const periodMonth = get('period_month');
      const periodYear = get('period_year');

      // Fetched unconditionally, even though it's only actually used if
      // this row turns out to be a fresh insert rather than an update to
      // an existing record (see the ON DUPLICATE KEY UPDATE clause below,
      // which deliberately never touches slip_snapshot) — simpler than
      // pre-checking whether the row already exists, and the extra lookup
      // costs nothing meaningful.
      const slipSnapshot = await captureSlipSnapshot(emp.id, emp.establishment_id, conn);

      await conn.query(
        `INSERT INTO salary_data
          (establishment_id, employee_id, period_month, period_year, paid_days, basic, hra, da,
           conveyance_allowance, overtime, gross_earnings, pf_deduction, esi_deduction, pt_deduction,
           tds_deduction, other_deduction, total_deduction, net_pay, uploaded_by, slip_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           paid_days=VALUES(paid_days), basic=VALUES(basic), hra=VALUES(hra), da=VALUES(da),
           conveyance_allowance=VALUES(conveyance_allowance), overtime=VALUES(overtime),
           gross_earnings=VALUES(gross_earnings), pf_deduction=VALUES(pf_deduction),
           esi_deduction=VALUES(esi_deduction), pt_deduction=VALUES(pt_deduction),
           tds_deduction=VALUES(tds_deduction), other_deduction=VALUES(other_deduction),
           total_deduction=VALUES(total_deduction), net_pay=VALUES(net_pay), downloaded=0`,
        [emp.establishment_id, emp.id, periodMonth, periodYear, get('paid_days'),
         basic, hra, da, conveyance, overtime, gross, pf, esi, pt, tds, otherDed, totalDed,
         gross - totalDed, uploadedById, slipSnapshot]
      );
      results.inserted++;
    } catch (err) {
      results.errors.push(`Row ${r}: ${err.message}`);
      results.skipped++;
    }
  }
}

// Runs a staged, already-validated file once its approval request is
// approved — no streaming, no cancellation (there's no live client waiting
// on this one), just a plain transaction and a final summary. The staged
// file itself is deleted by the Approvals route afterward.
async function applyImportSalaryData(filePath, uploadedById) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const header = sheet.getRow(1).values.map((v) => (v || '').toString().trim().toLowerCase());
  const colIndex = (name) => header.indexOf(name);

  const results = { inserted: 0, skipped: 0, errors: [] };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await processSalaryDataImportRows(conn, sheet, colIndex, results, () => {}, () => false, uploadedById);
    await conn.commit();
    return results;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------
// Bulk import from Excel (see TEMPLATE_HEADERS above for expected columns).
// ---------------------------------------------------------------
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

    // Reject the entire upload up front if any required cell anywhere in
    // the sheet is blank or non-numeric — nothing is saved in that case,
    // rather than silently defaulting bad cells to 0 or skipping just the
    // affected rows. See nullCellCheck.js for the exact rule.
    const nullProblems = findNullCellProblems(
      sheet, colIndex, TEMPLATE_HEADERS, TEMPLATE_HEADERS.filter((name) => name !== 'employee_id'),
      (row, ci) => {
        const periodError = validatePeriod(row.getCell(ci('period_month')).value, row.getCell(ci('period_year')).value);
        if (periodError) return periodError;
        return validateSalaryFigures(
          (name) => row.getCell(ci(name)).value,
          row.getCell(ci('period_month')).value,
          row.getCell(ci('period_year')).value
        );
      }
    );
    // Also reject the whole upload if the same employee+period combination
    // appears more than once in the file — otherwise the second occurrence
    // would silently overwrite the first with no warning. See
    // findDuplicatePeriodsInSheet above for why this check works the same
    // way regardless of the database's own primary-key structure.
    const duplicateProblems = findDuplicatePeriodsInSheet(sheet, colIndex);
    const allProblems = [...nullProblems, ...duplicateProblems];
    if (allProblems.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: nullCellErrorMessage(allProblems) });
    }

    // Non-Admin: the file already passed the same validation an Admin's
    // upload would — stage it for approval instead of importing it now.
    if (!isAdminUser(req)) {
      const rowCount = Math.max(0, sheet.rowCount - 1);
      await createApprovalRequest({
        req, moduleKey: 'upload_salary', action: 'IMPORT', stagedFilePath: req.file.path,
        description: `Bulk import ${rowCount} salary data row(s)`
      });
      return res.status(202).json({ message: 'Submitted for approval, pending.' });
    }

    const results = { inserted: 0, skipped: 0, errors: [] };
    const totalRows = Math.max(0, sheet.rowCount - 1);

    // Everything in this import runs inside one transaction on a dedicated
    // connection. If the request is aborted mid-way (e.g. the Cancel button
    // on the frontend), the transaction is rolled back in full so no
    // salary_data rows from a cancelled import are left in the database.
    const conn = await pool.getConnection();
    let cancelled = false;
    let reportProgress, sendDone, sendError;
    const onClose = () => { if (!res.writableEnded) cancelled = true; };
    req.on('close', onClose);

    try {
      await conn.beginTransaction();
      // Only start the streamed progress response once the transaction is
      // actually underway, so a connection/transaction failure above still
      // gets reported as a normal JSON error instead of a broken stream.
      const progress = startImportProgress(res, totalRows);
      ({ reportProgress, sendDone } = progress);
      sendError = progress.sendError;

      await processSalaryDataImportRows(conn, sheet, colIndex, results, reportProgress, () => cancelled, req.user.id);

      if (cancelled) {
        await conn.rollback();
      } else {
        await conn.commit();
        sendDone(results);
        await logActivity(req, 'IMPORT', 'upload_salary', `Imported salary data: ${results.inserted} record(s), ${results.skipped} skipped`);
      }
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* connection may already be broken */ }
      if (!cancelled) {
        if (sendError) {
          console.error(err);
          sendError(err.message || 'Import failed due to an unexpected server error.');
        } else {
          throw err; // headers not sent yet — the central error handler sends a clean JSON response
        }
      }
    } finally {
      req.removeListener('close', onClose);
      conn.release();
      fs.unlink(req.file.path, () => {});
    }
  }
);

// Called by the Approvals routes when an Admin approves a pending request
// for this module. Bulk Excel import is intentionally not included yet —
// staging a validated-but-unapplied file for approval is separate, larger
// work still in progress.
async function applyApprovedSalaryDataAction(action, targetId, payload, requestedBy, stagedFilePath) {
  switch (action) {
    case 'CREATE':
      return applyCreateSalaryData(payload, requestedBy);
    case 'UPDATE':
      return applyUpdateSalaryData(targetId, payload);
    case 'DELETE':
      return applyDeleteSalaryData(targetId);
    case 'BULK_DELETE':
      return applyDeleteGroups(payload.groups);
    case 'IMPORT':
      return applyImportSalaryData(stagedFilePath, requestedBy);
    default:
      throw new Error(`Unknown action "${action}" for upload_salary`);
  }
}

module.exports = router;
module.exports.applyApprovedAction = applyApprovedSalaryDataAction;
