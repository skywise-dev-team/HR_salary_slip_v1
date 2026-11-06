// Builds the plain-language "what is going to change" view of an approval
// request, shown to the approver: which employee / user / establishment /
// salary record it is about, and for every changed field the current value
// next to the requested one.
//
//   {
//     entries: [
//       { kind: 'change' | 'new' | 'delete', title, subtitle?, note?,
//         fields: [ { label, before, after } ] }
//     ],
//     note?:  text shown above the entries (e.g. for an Excel import),
//     hiddenEntries?: how many further entries were left out of a very large request
//   }
//
// Built when the request is created (kept for the history) and rebuilt live
// while the request is still pending, so the "current" column is always
// what the data looks like right now. Never throws: if anything goes wrong
// the request simply has no details view, it is never blocked by it.
const pool = require('../config/db');

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_ENTRIES = 1000;

const EMP_FIELDS = [
  ['employee_id', 'Employee ID'], ['full_name', 'Full name'], ['relative_name', "Father's / Mother's / Spouse's name"],
  ['relation', 'Relation'], ['designation', 'Designation'], ['uan', 'UAN'], ['bank_account_no', 'Bank account number'],
  ['establishment_id', 'Establishment'], ['active_from', 'Active from'], ['inactive_date', 'Inactive date'], ['status', 'Status'], ['email', 'Email'],
  ['app_access', 'App access'], ['salary_slip_access', 'Salary slip access']
];
const SALARY_FIELDS = [
  ['paid_days', 'Paid days'], ['basic', 'Basic'], ['hra', 'HRA'], ['da', 'DA'],
  ['conveyance_allowance', 'Conveyance Allowance'], ['overtime', 'Overtime'],
  ['pf_deduction', 'PF deduction'], ['esi_deduction', 'ESI deduction'], ['pt_deduction', 'P-Tax deduction'],
  ['tds_deduction', 'TDS deduction'], ['other_deduction', 'Other deduction']
];
const EARNINGS = ['basic', 'hra', 'da', 'conveyance_allowance', 'overtime'];
const DEDUCTIONS = ['pf_deduction', 'esi_deduction', 'pt_deduction', 'tds_deduction', 'other_deduction'];

const pad = (n) => String(n).padStart(2, '0');
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';

// Dates come out of MySQL as Date objects and out of forms as 'YYYY-MM-DD'.
function plain(v) {
  if (isEmpty(v)) return '';
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).trim().replace(/^(\d{4}-\d{2}-\d{2})T.*$/, '$1');
}
const show = (v) => (isEmpty(v) ? '—' : String(v));
const num = (v) => Number(v) || 0;
const money = (v) => num(v).toFixed(2);
const yesNo = (v) => (v === true || v === 1 || v === '1' || v === 'YES' || v === 'Yes' ? 'Yes' : 'No');

const field = (label, before, after) => ({ label, before: show(before), after: show(after) });

function mapValue(key, v, ctx) {
  const value = plain(v);
  if (!value) return '';
  if (key === 'establishment_id') return ctx.estNames[value] || value;
  if (key === 'role_id') return ctx.roleNames[value] || value;
  if (key === 'status') return ctx.module === 'employees' ? (value === 'ACTIVE' ? 'On rolls' : value === 'INACTIVE' ? 'Inactive' : value) : (value === 'ACTIVE' ? 'Active' : value === 'INACTIVE' ? 'Inactive' : value);
  if (key === 'app_access') return yesNo(value);
  if (key === 'can_approve') return yesNo(value);
  if (key === 'salary_slip_access') return ({ VIEW_ONLY: 'View only', VIEW_DOWNLOAD: 'View and download', NO_ACCESS: 'No access' })[value] || value;
  return value;
}

async function lookups(module) {
  const [ests] = await pool.query('SELECT id, name FROM establishments');
  const [roles] = await pool.query('SELECT id, role_name FROM roles');
  return {
    module,
    estNames: Object.fromEntries(ests.map((e) => [String(e.id), e.name])),
    roleNames: Object.fromEntries(roles.map((r) => [String(r.id), r.role_name]))
  };
}

// Changed fields only, between an existing row and a submitted payload.
// Keys missing from the payload are not part of the request and are skipped.
function diff(fields, before, after, ctx, numeric = false) {
  const out = [];
  for (const [key, label] of fields) {
    if (!(key in after)) continue;
    if (numeric) {
      if (num(before[key]) === num(after[key])) continue;
      out.push(field(label, money(before[key]), money(after[key])));
    } else {
      const b = plain(before[key]);
      const a = plain(after[key]);
      if (b === a) continue;
      out.push(field(label, mapValue(key, b, ctx), mapValue(key, a, ctx)));
    }
  }
  return out;
}

const netPay = (r) => EARNINGS.reduce((s, k) => s + num(r[k]), 0) - DEDUCTIONS.reduce((s, k) => s + num(r[k]), 0);

function capped(entries) {
  if (entries.length <= MAX_ENTRIES) return { entries };
  return { entries: entries.slice(0, MAX_ENTRIES), hiddenEntries: entries.length - MAX_ENTRIES };
}

// ------------------------------------------------------------------ employees
async function employeeRows(ids) {
  if (!ids.length) return [];
  const [rows] = await pool.query(
    `SELECT e.*, es.name AS establishment_name FROM employees e
     LEFT JOIN establishments es ON es.id = e.establishment_id WHERE e.id IN (?)`, [ids]
  );
  return rows;
}
const empTitle = (e) => `${e.employee_id} - ${e.full_name}`;
const empSummaryFields = (e, ctx) => [
  field('Designation', '', e.designation), field('Establishment', '', mapValue('establishment_id', e.establishment_id, ctx)),
  field('UAN', '', e.uan), field('Status', '', mapValue('status', e.status, ctx))
].map((f) => ({ label: f.label, after: f.after }));

async function employeesDetails(action, targetId, p) {
  const ctx = await lookups('employees');
  switch (action) {
    case 'CREATE': {
      const fields = EMP_FIELDS.filter(([k]) => !isEmpty(p[k])).map(([k, l]) => ({ label: l, after: mapValue(k, p[k], ctx) }));
      if (!isEmpty(p.effective_date)) fields.push({ label: 'Effective from', after: plain(p.effective_date) });
      return { entries: [{ kind: 'new', title: `New employee ${p.employee_id} - ${p.full_name}`, fields }] };
    }
    case 'UPDATE': {
      const [e] = await employeeRows([targetId]);
      if (!e) return { entries: [], note: 'The employee this request is about no longer exists.' };
      const fields = diff(EMP_FIELDS, e, p, ctx);
      if (fields.length && !isEmpty(p.effective_date)) fields.push({ label: 'Effective from', before: '—', after: plain(p.effective_date) });
      return { entries: [{ kind: 'change', title: empTitle(e), subtitle: e.establishment_name, fields, note: fields.length ? undefined : 'No change in the employee details.' }] };
    }
    case 'STATUS_CHANGE': {
      const [e] = await employeeRows([targetId]);
      if (!e) return { entries: [], note: 'The employee this request is about no longer exists.' };
      return { entries: [{ kind: 'change', title: empTitle(e), subtitle: e.establishment_name, fields: [field('Status', mapValue('status', e.status, ctx), mapValue('status', p.status, ctx))] }] };
    }
    case 'APP_ACCESS': {
      const [e] = await employeeRows([targetId]);
      if (!e) return { entries: [], note: 'The employee this request is about no longer exists.' };
      return { entries: [{ kind: 'change', title: empTitle(e), subtitle: e.establishment_name, fields: [field('App access', e.app_access === 'YES' ? 'Yes' : 'No', p.app_access === 'YES' ? 'Yes' : 'No')] }] };
    }
    case 'BULK_APP_ACCESS': {
      const rows = await employeeRows(p.ids || []);
      return capped(rows.map((e) => ({ itemId: e.id, kind: 'change', title: empTitle(e), subtitle: e.establishment_name,
        fields: [field('App access', e.app_access === 'YES' ? 'Yes' : 'No', p.app_access === 'YES' ? 'Yes' : 'No')] })));
    }
    case 'BULK_STATUS_CHANGE': {
      const rows = await employeeRows(p.ids || []);
      return capped(rows.map((e) => ({ itemId: e.id, kind: 'change', title: empTitle(e), subtitle: e.establishment_name,
        fields: [field('Status', mapValue('status', e.status, ctx), mapValue('status', p.status, ctx))] })));
    }
    case 'DELETE': {
      const [e] = await employeeRows([targetId]);
      if (!e) return { entries: [], note: 'The employee this request is about no longer exists.' };
      return { entries: [{ kind: 'delete', title: empTitle(e), subtitle: e.establishment_name, fields: empSummaryFields(e, ctx) }] };
    }
    case 'BULK_DELETE': {
      const rows = await employeeRows(p.ids || []);
      return capped(rows.map((e) => ({ itemId: e.id, kind: 'delete', title: empTitle(e), subtitle: e.establishment_name, fields: empSummaryFields(e, ctx) })));
    }
    case 'IMPORT':
      return { entries: [], note: 'Excel upload of employees. Use "Download to review" on this request to see every row before deciding.' };
    default:
      return { entries: [] };
  }
}

// ---------------------------------------------------------------------- users
async function userRows(ids) {
  if (!ids.length) return [];
  const [rows] = await pool.query(
    `SELECT u.id, u.user_id, u.email, u.role_id, u.status, u.can_approve, r.role_name
     FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id IN (?)`, [ids]
  );
  return rows;
}

// "All establishments" / the names / "None" - how a user's establishment
// access is shown to the approver.
function accessText(all, ids, ctx) {
  if (all === true || all === 1 || all === '1') return 'All establishments';
  const names = (Array.isArray(ids) ? ids : []).map((i) => ctx.estNames[String(i)] || `Establishment ${i}`);
  return names.length ? names.join(', ') : 'None';
}
async function currentAccessText(userId, ctx) {
  const [[u]] = await pool.query('SELECT all_establishments FROM users WHERE id = ?', [userId]);
  const [links] = await pool.query('SELECT establishment_id FROM user_establishments WHERE user_id = ?', [userId]);
  return accessText(u?.all_establishments, links.map((l) => l.establishment_id), ctx);
}

async function usersDetails(action, targetId, p) {
  const ctx = await lookups('users');
  const gone = { entries: [], note: 'The user this request is about no longer exists.' };
  switch (action) {
    case 'CREATE': {
      const fields = [
        { label: 'User ID', after: show(p.user_id) }, { label: 'Email', after: show(p.email) },
        { label: 'Role', after: mapValue('role_id', p.role_id, ctx) || '—' },
        { label: 'Can approve', after: yesNo(p.can_approve) }, { label: 'Password', after: 'Set by the requester (not shown)' },
        { label: 'Establishment access', after: accessText(p.all_establishments, p.establishment_ids, ctx) }
      ];
      return { entries: [{ kind: 'new', title: `New user ${p.user_id}`, fields }] };
    }
    case 'UPDATE': {
      const [u] = await userRows([targetId]);
      if (!u) return gone;
      const fields = [];
      if ('email' in p && plain(u.email) !== plain(p.email)) fields.push(field('Email', u.email, p.email));
      if ('role_id' in p && String(u.role_id) !== String(p.role_id)) fields.push(field('Role', u.role_name, mapValue('role_id', p.role_id, ctx)));
      if ('can_approve' in p && yesNo(u.can_approve) !== yesNo(p.can_approve)) fields.push(field('Can approve', yesNo(u.can_approve), yesNo(p.can_approve)));
      if (!isEmpty(p.password)) fields.push(field('Password', '—', 'Will be changed (not shown)'));
      if ('all_establishments' in p || 'establishment_ids' in p) {
        const before = await currentAccessText(targetId, ctx);
        const after = accessText(p.all_establishments, p.establishment_ids, ctx);
        if (before !== after) fields.push(field('Establishment access', before, after));
      }
      return { entries: [{ kind: 'change', title: u.user_id, fields, note: fields.length ? undefined : 'No change in the user details.' }] };
    }
    case 'STATUS_CHANGE': {
      const [u] = await userRows([targetId]);
      if (!u) return gone;
      return { entries: [{ kind: 'change', title: u.user_id, fields: [field('Status', mapValue('status', u.status, ctx), mapValue('status', p.status, ctx))] }] };
    }
    case 'BULK_STATUS_CHANGE': {
      const rows = await userRows(p.ids || []);
      return capped(rows.map((u) => ({ itemId: u.id, kind: 'change', title: u.user_id, fields: [field('Status', mapValue('status', u.status, ctx), mapValue('status', p.status, ctx))] })));
    }
    case 'BULK_ROLE_CHANGE': {
      const rows = await userRows(p.ids || []);
      return capped(rows.map((u) => ({ itemId: u.id, kind: 'change', title: u.user_id, fields: [field('Role', u.role_name, mapValue('role_id', p.role_id, ctx))] })));
    }
    case 'DELETE': {
      const [u] = await userRows([targetId]);
      if (!u) return gone;
      return { entries: [{ kind: 'delete', title: u.user_id, fields: [{ label: 'Email', after: show(u.email) }, { label: 'Role', after: show(u.role_name) }] }] };
    }
    case 'BULK_DELETE': {
      const rows = await userRows(p.ids || []);
      return capped(rows.map((u) => ({ itemId: u.id, kind: 'delete', title: u.user_id, fields: [{ label: 'Email', after: show(u.email) }, { label: 'Role', after: show(u.role_name) }] })));
    }
    case 'IMPORT':
      return { entries: [], note: 'Excel upload of users. Use "Download to review" on this request to see every row before deciding.' };
    default:
      return { entries: [] };
  }
}

// ---------------------------------------------------------------- salary data
async function salaryRows(ids) {
  if (!ids.length) return [];
  const [rows] = await pool.query(
    `SELECT sd.*, e.employee_id AS emp_code, e.full_name, es.name AS establishment_name
     FROM salary_data sd JOIN employees e ON e.id = sd.employee_id JOIN establishments es ON es.id = sd.establishment_id
     WHERE sd.id IN (?)`, [ids]
  );
  return rows;
}
const salaryTitle = (r) => `${r.emp_code} - ${r.full_name} — ${MONTHS[r.period_month]} ${r.period_year}`;

function salaryChange(r, afterValues) {
  const fields = diff(SALARY_FIELDS, r, afterValues, null, true);
  if (fields.length) fields.push(field('Net pay', money(r.net_pay), money(netPay({ ...r, ...afterValues }))));
  return { itemId: r.id, kind: 'change', title: salaryTitle(r), subtitle: r.establishment_name, fields, note: fields.length ? undefined : 'No change in the figures.' };
}

async function salaryDetails(action, targetId, p) {
  switch (action) {
    case 'CREATE': {
      const [[emp]] = await pool.query('SELECT employee_id, full_name FROM employees WHERE id = ?', [p.employee_id]);
      const [[est]] = await pool.query('SELECT name FROM establishments WHERE id = ?', [p.establishment_id]);
      const fields = SALARY_FIELDS.map(([k, l]) => ({ label: l, after: money(p[k]) }));
      fields.push({ label: 'Net pay', after: money(netPay(p)) });
      return { entries: [{ kind: 'new', title: `${emp ? `${emp.employee_id} - ${emp.full_name}` : `Employee ${p.employee_id}`} — ${MONTHS[Number(p.period_month)] || p.period_month} ${p.period_year}`, subtitle: est?.name, fields }] };
    }
    case 'UPDATE': {
      const [r] = await salaryRows([targetId]);
      if (!r) return { entries: [], note: 'The salary record this request is about no longer exists.' };
      return { entries: [salaryChange(r, p)] };
    }
    case 'BULK_UPDATE': {
      const rows = await salaryRows(p.ids || []);
      return capped(rows.map((r) => salaryChange(r, p.changes || {})));
    }
    case 'DELETE': {
      const [r] = await salaryRows([targetId]);
      if (!r) return { entries: [], note: 'The salary record this request is about no longer exists.' };
      return { entries: [{ kind: 'delete', title: salaryTitle(r), subtitle: r.establishment_name,
        fields: [{ label: 'Gross earnings', after: money(r.gross_earnings) }, { label: 'Total deductions', after: money(r.total_deduction) }, { label: 'Net pay', after: money(r.net_pay) }] }] };
    }
    case 'BULK_DELETE_RECORDS': {
      const rows = await salaryRows(p.ids || []);
      const entries = rows.map((r) => ({ itemId: r.id, kind: 'delete', title: salaryTitle(r), subtitle: r.establishment_name,
        fields: [{ label: 'Gross earnings', after: money(r.gross_earnings) }, { label: 'Total deductions', after: money(r.total_deduction) }, { label: 'Net pay', after: money(r.net_pay) }] }));
      const result = capped(entries);
      const gone = (p.ids || []).length - rows.length;
      if (gone > 0) result.note = `${gone} of the selected record(s) no longer exist.`;
      return result;
    }
    case 'BULK_DELETE': {
      const entries = [];
      for (const g of p.groups || []) {
        const [[est]] = await pool.query('SELECT name FROM establishments WHERE id = ?', [g.establishment_id]);
        const [[agg]] = await pool.query(
          'SELECT COUNT(*) AS records, COALESCE(SUM(net_pay), 0) AS total FROM salary_data WHERE establishment_id = ? AND period_month = ? AND period_year = ?',
          [g.establishment_id, g.period_month, g.period_year]
        );
        entries.push({ kind: 'delete', title: `${est?.name || `Establishment ${g.establishment_id}`} — ${MONTHS[Number(g.period_month)]} ${g.period_year}`,
          fields: [{ label: 'Salary records that will be deleted', after: String(agg.records) }, { label: 'Total net pay', after: money(agg.total) }] });
      }
      return { entries };
    }
    case 'ARREAR_CREATE': {
      const [[emp]] = await pool.query('SELECT employee_id, full_name FROM employees WHERE id = ?', [p.employee_id]);
      const [[est]] = await pool.query('SELECT name FROM establishments WHERE id = ?', [p.establishment_id]);
      const fields = SALARY_FIELDS.map(([k, l]) => ({ label: l, after: money(p[k]) }));
      fields.push({ label: 'Net pay', after: money(netPay(p)) });
      const who = emp ? `${emp.employee_id} - ${emp.full_name}` : `Employee ${p.employee_id}`;
      return { entries: [{ kind: 'new', title: `${who} — arrear for ${MONTHS[Number(p.arrear_from_month)] || p.arrear_from_month} ${p.arrear_from_year} to ${MONTHS[Number(p.arrear_to_month)] || p.arrear_to_month} ${p.arrear_to_year}`, subtitle: est?.name, fields }] };
    }
    case 'ARREAR_UPDATE': {
      const [r] = await arrearRows([targetId]);
      if (!r) return { entries: [], note: 'The arrear record this request is about no longer exists.' };
      const fields = [];
      const per = (m, y) => `${MONTHS[Number(m)] || m} ${y}`;
      const bFrom = per(r.arrear_from_month, r.arrear_from_year);
      const aFrom = per(p.arrear_from_month ?? r.arrear_from_month, p.arrear_from_year ?? r.arrear_from_year);
      if (aFrom !== bFrom) fields.push(field('Arrear from', bFrom, aFrom));
      const bTo = per(r.arrear_to_month, r.arrear_to_year);
      const aTo = per(p.arrear_to_month ?? r.arrear_to_month, p.arrear_to_year ?? r.arrear_to_year);
      if (aTo !== bTo) fields.push(field('Arrear to', bTo, aTo));
      if ('date_of_issue' in p && plain(r.date_of_issue) !== plain(p.date_of_issue)) {
        fields.push(field('Date of issue', plain(r.date_of_issue), plain(p.date_of_issue)));
      }
      const figures = diff(SALARY_FIELDS, r, p, null, true);
      fields.push(...figures);
      if (figures.length) fields.push(field('Net pay', money(r.net_pay), money(netPay({ ...r, ...p }))));
      return { entries: [{ itemId: r.id, kind: 'change', title: arrearTitle(r), subtitle: r.establishment_name, fields, note: fields.length ? undefined : 'No change in the arrear record.' }] };
    }
    case 'ARREAR_DELETE': {
      const rows = await arrearRows(p.ids || []);
      const result = capped(rows.map((r) => ({ kind: 'delete', title: arrearTitle(r), subtitle: r.establishment_name,
        fields: [{ label: 'Gross earnings', after: money(r.gross_earnings) }, { label: 'Total deductions', after: money(r.total_deduction) }, { label: 'Net pay', after: money(r.net_pay) }] })));
      const gone = (p.ids || []).length - rows.length;
      if (gone > 0) result.note = `${gone} of the selected arrear record(s) no longer exist.`;
      return result;
    }
    case 'ARREAR_IMPORT':
      return { entries: [], note: 'Excel upload of arrear salary data. A row for an employee and arrear period that already exists is updated. Use "Download to review" on this request to see every row before deciding.' };
    case 'IMPORT':
      return { entries: [], note: 'Excel upload of salary data. Rows for an employee and month that already exist are updated. Use "Download to review" on this request to see every row before deciding.' };
    default:
      return { entries: [] };
  }
}

// ------------------------------------------------------------- arrear salary
async function arrearRows(ids) {
  if (!ids.length) return [];
  const [rows] = await pool.query(
    `SELECT a.*, e.employee_id AS emp_code, e.full_name, es.name AS establishment_name
     FROM arrear_data a JOIN employees e ON e.id = a.employee_id JOIN establishments es ON es.id = a.establishment_id
     WHERE a.id IN (?)`, [ids]
  );
  return rows;
}
const arrearTitle = (r) => `${r.emp_code} - ${r.full_name} — arrear for ${MONTHS[r.arrear_from_month]} ${r.arrear_from_year} to ${MONTHS[r.arrear_to_month]} ${r.arrear_to_year}`;

// -------------------------------------------------------------- establishments
async function establishmentsDetails(action, targetId, p) {
  const [[est]] = await pool.query('SELECT * FROM establishments WHERE id = ?', [targetId]);
  if (!est) return { entries: [], note: 'The establishment this request is about no longer exists.' };
  const title = `${est.est_code} - ${est.name}`;
  if (action === 'UPDATE') {
    const fields = diff([['est_code', 'Establishment code'], ['name', 'Name'], ['signatory_name', 'Signatory name'], ['address', 'Address']], est, p, null);
    if (p.logo_path) fields.push(field('Logo', est.logo_path ? 'Current logo' : '', 'New logo uploaded'));
    if (p.signature_path) fields.push(field('Signature image', est.signature_path ? 'Current signature' : '', 'New signature uploaded'));
    if (fields.length && !isEmpty(p.effective_date)) fields.push({ label: 'Effective from', before: '—', after: plain(p.effective_date) });
    return { entries: [{ kind: 'change', title, fields, note: fields.length ? undefined : 'No change in the establishment details.' }] };
  }
  if (action === 'DELETE') {
    const [[emps]] = await pool.query('SELECT COUNT(*) AS n FROM employees WHERE establishment_id = ?', [targetId]);
    const [[sal]] = await pool.query('SELECT COUNT(*) AS n FROM salary_data WHERE establishment_id = ?', [targetId]);
    return { entries: [{ kind: 'delete', title, fields: [
      { label: 'Address', after: show(est.address) }, { label: 'Signatory', after: show(est.signatory_name) },
      { label: 'Employees linked to it', after: String(emps.n) }, { label: 'Salary records linked to it', after: String(sal.n) }
    ] }] };
  }
  return { entries: [] };
}

async function buildChangeDetails(moduleKey, action, targetId, payload) {
  try {
    const p = (typeof payload === 'string' ? JSON.parse(payload) : payload) || {};
    switch (moduleKey) {
      case 'employees': return await employeesDetails(action, targetId, p);
      case 'users': return await usersDetails(action, targetId, p);
      case 'upload_salary': return await salaryDetails(action, targetId, p);
      case 'establishments': return await establishmentsDetails(action, targetId, p);
      default: return null;
    }
  } catch (err) {
    console.error('buildChangeDetails failed:', err.message);
    return null;
  }
}

module.exports = { buildChangeDetails };
