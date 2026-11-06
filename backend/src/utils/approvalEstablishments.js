// Works out which establishment(s) an approval request is about, so it can be
// sent only to approvers who have access to those establishments. Called once,
// when the request is created, and stored with it (approval_requests.establishment_ids).
//
// An empty list means "not tied to an establishment" (a Users request, or a new
// establishment), and then no establishment check is applied to the approvers.
const ExcelJS = require('exceljs');
const pool = require('../config/db');
const { isRestricted } = require('./establishmentScope');

const cleanIds = (v) => [...new Set((Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

// Establishments behind a list of ids in employees / salary_data / arrear_data.
// `table` is always one of those literals below, never request input.
async function viaTable(table, ids) {
  const list = cleanIds(ids);
  if (!list.length) return [];
  const [rows] = await pool.query(`SELECT DISTINCT establishment_id FROM ${table} WHERE id IN (?)`, [list]);
  return rows.map((r) => Number(r.establishment_id));
}

// An Excel import: the establishments of the rows in the staged file. The
// employee import names the establishment on each row; the salary and arrear
// imports name the employee, whose establishment is then looked up.
async function fromImportFile(moduleKey, filePath) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values.map((v) => (v || '').toString().trim().toLowerCase());
    const column = header.indexOf(moduleKey === 'employees' ? 'establishment_code' : 'employee_id');
    if (column < 1) return [];
    const values = new Set();
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      const raw = sheet.getRow(r).getCell(column).value;
      const text = raw && typeof raw === 'object' && 'text' in raw ? raw.text : raw;
      if (text !== null && text !== undefined && String(text).trim() !== '') values.add(String(text).trim());
    }
    const list = [...values];
    const found = new Set();
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      const [rows] = moduleKey === 'employees'
        ? await pool.query('SELECT id AS establishment_id FROM establishments WHERE est_code IN (?)', [chunk])
        : await pool.query('SELECT DISTINCT establishment_id FROM employees WHERE employee_id IN (?)', [chunk]);
      rows.forEach((r) => found.add(Number(r.establishment_id)));
    }
    return [...found];
  } catch (err) {
    console.error('Could not read the establishments of an import file:', err.message);
    return [];
  }
}

async function requestEstablishments({ req, moduleKey, action, targetId, payload, stagedFilePath }) {
  const p = payload || {};
  let found = [];

  if (moduleKey === 'employees') {
    if (action === 'CREATE') found = [p.establishment_id];
    else if (action === 'UPDATE') found = [p.establishment_id, ...(await viaTable('employees', [targetId]))];
    else if (action === 'STATUS_CHANGE' || action === 'APP_ACCESS' || action === 'DELETE') found = await viaTable('employees', [targetId]);
    else if (action === 'BULK_STATUS_CHANGE' || action === 'BULK_APP_ACCESS' || action === 'BULK_DELETE') found = await viaTable('employees', p.ids);
    else if (action === 'IMPORT' && stagedFilePath) found = await fromImportFile('employees', stagedFilePath);
  } else if (moduleKey === 'establishments') {
    if (targetId) found = [targetId];
  } else if (moduleKey === 'upload_salary') {
    if (action === 'CREATE' || action === 'ARREAR_CREATE') found = [p.establishment_id];
    else if (action === 'UPDATE' || action === 'DELETE') found = [p.establishment_id, ...(await viaTable('salary_data', [targetId]))];
    else if (action === 'BULK_UPDATE' || action === 'BULK_DELETE_RECORDS') found = await viaTable('salary_data', p.ids);
    else if (action === 'BULK_DELETE') found = (Array.isArray(p.groups) ? p.groups : []).map((g) => g.establishment_id);
    else if (action === 'ARREAR_UPDATE') found = [p.establishment_id, ...(await viaTable('arrear_data', [targetId]))];
    else if (action === 'ARREAR_DELETE') found = await viaTable('arrear_data', p.ids);
    else if ((action === 'IMPORT' || action === 'ARREAR_IMPORT') && stagedFilePath) found = await fromImportFile('upload_salary', stagedFilePath);
  }

  let list = cleanIds(found);
  // An import whose file could not be read: fall back to the requester's own establishments.
  if (!list.length && /IMPORT$/.test(action) && isRestricted(req)) list = cleanIds(req.user.estScope);
  return list;
}

module.exports = { requestEstablishments };
