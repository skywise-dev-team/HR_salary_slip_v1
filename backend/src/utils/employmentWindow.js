// ---- Salary only within the months the employee is active -----------------
// Never before the month of the Active-from date, and never after the month
// of the Inactive date (the inactive month itself is allowed).
const WINDOW_MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayKey = (iso) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
const monthText = (iso) => `${WINDOW_MONTHS[Number(iso.slice(5, 7))]}-${iso.slice(0, 4)}`;
function employmentWindowError(emp, month, year, label) {
  const future = futureMonthError(label, month, year);
  if (future) return future;
  const k = Number(year) * 12 + Number(month);
  const when = `${WINDOW_MONTHS[Number(month)]}-${year}`;
  if (emp.active_from && k < dayKey(emp.active_from)) {
    return `${label} is active from ${monthText(emp.active_from)}, so salary cannot be uploaded for ${when}`;
  }
  if (emp.inactive_date && k > dayKey(emp.inactive_date)) {
    return `${label} became inactive in ${monthText(emp.inactive_date)}, so salary cannot be uploaded for ${when}`;
  }
  return null;
}
const EMP_WINDOW_SQL = `SELECT employee_id, DATE_FORMAT(active_from, '%Y-%m-%d') AS active_from,
  DATE_FORMAT(CASE WHEN status = 'INACTIVE' THEN inactive_date END, '%Y-%m-%d') AS inactive_date FROM employees`;


// ---- No employee date may fall before the Active-from date -----------------
const pad2 = (n) => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
// 'YYYY-MM-DD' for a Date or an ISO-like string; null when blank / unreadable.
function toIso(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const showDate = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

// No date may be after today; a pay / arrear month may not be after this month.
function futureDateError(label, what, dateIso) {
  if (!dateIso || dateIso <= todayIso()) return null;
  return `${label}: ${what} (${showDate(dateIso)}) cannot be after today's date (${showDate(todayIso())})`;
}
function futureMonthError(label, month, year) {
  const t = todayIso();
  if (Number(year) * 12 + Number(month) <= dayKey(t)) return null;
  return `${label}: ${WINDOW_MONTHS[Number(month)]}-${year} is after the current month (${WINDOW_MONTHS[Number(t.slice(5, 7))]}-${t.slice(0, 4)}), so it cannot be used`;
}

// `what` e.g. "Effective from date"; returns a message or null.
function beforeActiveFromError(label, what, dateIso, activeIso) {
  if (!dateIso || !activeIso || dateIso >= activeIso) return null;
  return `${what} (${showDate(dateIso)}) cannot be before ${label}'s Active from date (${showDate(activeIso)})`;
}

// An arrear slip's date of issue must fall after the arrear "to" month ends -
// never inside, or before, the period it pays for.
function issueAfterPeriodError(toMonth, toYear, issueIso, label) {
  if (!issueIso) return null;
  const m = Number(toMonth);
  const y = Number(toYear);
  const nextStart = m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
  if (issueIso >= nextStart) return null;
  return `${label}: date of issue (${showDate(issueIso)}) must be after the arrear period, which ends in ${WINDOW_MONTHS[m]}-${y} (on or after ${showDate(nextStart)})`;
}

// Date of issue of an arrear slip.
function issueDateError(emp, issueIso, label) {
  return futureDateError(label, 'Date of issue', issueIso) || beforeActiveFromError(label, 'Date of issue', issueIso, emp.active_from);
}

// Effective-from / inactive date entered with an employee save.
function employeeDateError(body, activeFromIso, label, currentInactiveIso) {
  const eff = toIso(body.effective_date) || todayIso();
  const e1 = futureDateError(label, 'Effective from date', eff) || beforeActiveFromError(label, 'Effective from date', eff, activeFromIso);
  if (e1) return e1;
  if ((body.status || 'ACTIVE') === 'INACTIVE') {
    const inactive = toIso(body.inactive_date) || currentInactiveIso || todayIso();
    return futureDateError(label, 'Inactive date', inactive) || beforeActiveFromError(label, 'Inactive date', inactive, activeFromIso);
  }
  return null;
}

// Active-from can never move past any salary month, arrear period, arrear
// date of issue or detail effective-from date already recorded for the employee.
async function activeFromConflict(db, employeeRowId, newActiveIso, label) {
  if (!newActiveIso) return null;
  const key = Number(newActiveIso.slice(0, 4)) * 12 + Number(newActiveIso.slice(5, 7));
  const [[sal]] = await db.query(
    'SELECT period_year, period_month FROM salary_data WHERE employee_id = ? ORDER BY period_year, period_month LIMIT 1', [employeeRowId]);
  if (sal && sal.period_year * 12 + sal.period_month < key) {
    return `${label} already has salary data for ${WINDOW_MONTHS[sal.period_month]}-${sal.period_year}, so Active from cannot be moved to ${showDate(newActiveIso)}. Delete or correct that salary data first`;
  }
  const [[arr]] = await db.query(
    'SELECT arrear_from_year, arrear_from_month FROM arrear_data WHERE employee_id = ? ORDER BY arrear_from_year, arrear_from_month LIMIT 1', [employeeRowId]);
  if (arr && arr.arrear_from_year * 12 + arr.arrear_from_month < key) {
    return `${label} already has arrear salary data from ${WINDOW_MONTHS[arr.arrear_from_month]}-${arr.arrear_from_year}, so Active from cannot be moved to ${showDate(newActiveIso)}. Delete or correct that arrear data first`;
  }
  const [[iss]] = await db.query(
    "SELECT DATE_FORMAT(MIN(date_of_issue), '%Y-%m-%d') AS first FROM arrear_data WHERE employee_id = ?", [employeeRowId]);
  if (iss && iss.first && iss.first < newActiveIso) {
    return `${label} has an arrear slip issued on ${showDate(iss.first)}, so Active from cannot be moved to ${showDate(newActiveIso)}. Correct that date of issue first`;
  }
  const [[ver]] = await db.query(
    "SELECT DATE_FORMAT(MIN(effective_from), '%Y-%m-%d') AS first FROM employee_versions WHERE employee_id = ?", [employeeRowId]);
  if (ver && ver.first && ver.first < newActiveIso) {
    return `${label} has saved details effective from ${showDate(ver.first)}, so Active from cannot be moved to ${showDate(newActiveIso)}`;
  }
  return null;
}

// Date a new detail version should carry: today, or the Active-from date when that is later.
function versionDateFor(activeFrom) {
  const a = toIso(activeFrom);
  const t = todayIso();
  return a && a > t ? a : null;
}

module.exports = {
  employmentWindowError, EMP_WINDOW_SQL, WINDOW_MONTHS,
  toIso, todayIso, futureDateError, beforeActiveFromError, issueDateError, issueAfterPeriodError, employeeDateError, activeFromConflict, versionDateFor
};
