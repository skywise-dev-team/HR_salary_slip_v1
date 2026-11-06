const pool = require('../config/db');

// Human wording for the Approvals inbox: employees are shown by their
// Employee ID (e.g. B0000174) and name, never by an internal database number.

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const periodText = (m, y) => `${MONTHS[Number(m)] || m}-${y}`;
const cut = (s) => (s.length > 250 ? `${s.slice(0, 247)}...` : s);

// "B0000174 (Rakesh Bose)" for an employees.id
async function employeeLabel(employeeDbId) {
  const [[e]] = await pool.query('SELECT employee_id, full_name FROM employees WHERE id = ?', [employeeDbId]);
  return e ? `${e.employee_id} (${e.full_name})` : `#${employeeDbId}`;
}

// Employees behind a list of salary_data / arrear_data record ids, e.g.
// "B0000174, B0000175 and 3 more".
async function recordEmployeesText(table, ids) {
  if (table !== 'salary_data' && table !== 'arrear_data') return '';
  const list = (ids || []).slice(0, 2000);
  if (!list.length) return '';
  const [rows] = await pool.query(
    `SELECT DISTINCT e.employee_id FROM ${table} t JOIN employees e ON e.id = t.employee_id WHERE t.id IN (?) ORDER BY e.employee_id`, [list]
  );
  const codes = rows.map((r) => r.employee_id);
  if (!codes.length) return '';
  return codes.length <= 3 ? codes.join(', ') : `${codes.slice(0, 3).join(', ')} and ${codes.length - 3} more`;
}

// One record's employee and period, e.g. "B0000174 (Rakesh Bose), May-2026"
async function salaryRecordLabel(id) {
  const [[r]] = await pool.query(
    `SELECT e.employee_id, e.full_name, t.period_month, t.period_year FROM salary_data t JOIN employees e ON e.id = t.employee_id WHERE t.id = ?`, [id]
  );
  return r ? `${r.employee_id} (${r.full_name}), ${periodText(r.period_month, r.period_year)}` : `record ${id}`;
}
async function arrearRecordLabel(id) {
  const [[r]] = await pool.query(
    `SELECT e.employee_id, e.full_name FROM arrear_data t JOIN employees e ON e.id = t.employee_id WHERE t.id = ?`, [id]
  );
  return r ? `${r.employee_id} (${r.full_name})` : `record ${id}`;
}

module.exports = { employeeLabel, recordEmployeesText, salaryRecordLabel, arrearRecordLabel, periodText, cut };
