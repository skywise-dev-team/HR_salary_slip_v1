const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const { generateSalarySlipPdf, formatDate } = require('./pdfGenerator');

const LOGOS_DIR = path.join(__dirname, '..', '..', 'uploads', 'logos');
const SIGNATURES_DIR = path.join(__dirname, '..', '..', 'uploads', 'signatures');

// Captures exactly the fields that must never retroactively change on an
// already-issued slip: everything about the employee and establishment
// that a later edit could otherwise silently apply to old, already-issued
// slips (designation, bank account number, establishment address,
// signatory name, and which logo/signature file was current). Returns a
// JSON string ready to store directly in salary_data.slip_snapshot.
//
// Called exactly once — at the moment a salary_data row is first created
// (single add or bulk import) — and never again for that same row
// afterward, even if it's later edited or re-imported. A new upload of a
// logo or signature never overwrites or deletes the previous file (each
// upload gets its own unique filename — see middleware/upload.js), so the
// exact logo_path/signature_path string captured here keeps resolving to
// the historically correct file even after a later change.
async function captureSlipSnapshot(employeeId, establishmentId, db = pool) {
  const [[emp]] = await db.query(
    `SELECT employee_id AS emp_code, full_name, relative_name, relation, designation, uan, bank_account_no
     FROM employees WHERE id = ?`,
    [employeeId]
  );
  const [[est]] = await db.query(
    `SELECT name AS establishment_name, address, signatory_name, logo_path, signature_path
     FROM establishments WHERE id = ?`,
    [establishmentId]
  );
  return JSON.stringify({ ...emp, ...est });
}

// Resolves a snapshot's bare logo/signature filenames into full paths on
// disk, the same way the old file-based version always did — including the
// fallback for an establishment that uploaded its signature before the
// upload-middleware fix that routed signatures to their own folder.
function resolveImagePaths(snapshot) {
  const logo_path = snapshot.logo_path ? path.join(LOGOS_DIR, snapshot.logo_path) : null;
  let signature_path = null;
  if (snapshot.signature_path) {
    const inSignatures = path.join(SIGNATURES_DIR, snapshot.signature_path);
    const inLogos = path.join(LOGOS_DIR, snapshot.signature_path);
    signature_path = fs.existsSync(inSignatures) ? inSignatures : (fs.existsSync(inLogos) ? inLogos : inSignatures);
  }
  return { logo_path, signature_path };
}

// Builds the exact "record" shape generateSalarySlipPdf() expects, for one
// salary_data row. Uses that row's own frozen slip_snapshot whenever one
// exists — the normal path for every row created going forward. Falls back
// to a live join to employees/establishments only for a row created before
// this snapshot mechanism existed (slip_snapshot is NULL) — a safety net
// for old data, not something new rows ever need.
async function buildSlipRecord(salaryDataId, db = pool) {
  const [[sd]] = await db.query('SELECT * FROM salary_data WHERE id = ?', [salaryDataId]);
  if (!sd) throw new Error(`Salary data record ${salaryDataId} not found`);

  // sd.slip_snapshot comes back from a MySQL JSON-typed column — mysql2
  // auto-deserializes that into a real object already, not a string
  // needing JSON.parse (the same gotcha as the payload column elsewhere
  // in this app).
  let snapshot = sd.slip_snapshot;
  if (!snapshot) {
    const [[emp]] = await db.query(
      `SELECT employee_id AS emp_code, full_name, relative_name, relation, designation, uan, bank_account_no
       FROM employees WHERE id = ?`,
      [sd.employee_id]
    );
    const [[est]] = await db.query(
      `SELECT name AS establishment_name, address, signatory_name, logo_path, signature_path
       FROM establishments WHERE id = ?`,
      [sd.establishment_id]
    );
    snapshot = { ...emp, ...est };
  }

  const { logo_path, signature_path } = resolveImagePaths(snapshot);

  // "Date of issue" is a fixed business date, not a record of any technical
  // processing timestamp — always the 7th of the month immediately
  // following the pay period. A December period rolls into January of the
  // following year (e.g. December 2025 -> 07-01-2026).
  const issueMonth = sd.period_month === 12 ? 1 : sd.period_month + 1;
  const issueYear = sd.period_month === 12 ? sd.period_year + 1 : sd.period_year;

  return {
    ...sd,
    ...snapshot,
    logo_path,
    signature_path,
    issueDate: formatDate(new Date(issueYear, issueMonth - 1, 7))
  };
}

// Generates one slip's PDF as a Buffer, fresh, right now — nothing here is
// ever saved to disk. Called at the moment someone actually previews or
// downloads a slip (single or as part of a bulk ZIP), not before.
async function generateSlipBuffer(salaryDataId, db = pool) {
  const record = await buildSlipRecord(salaryDataId, db);
  return generateSalarySlipPdf(record);
}

module.exports = { captureSlipSnapshot, buildSlipRecord, generateSlipBuffer, LOGOS_DIR, SIGNATURES_DIR };
