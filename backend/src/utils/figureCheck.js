// Salary figures must always be filled in: every figure is either 0 or more,
// never blank and never negative. Used for single entries, edits and Excel rows.
const LABELS = {
  paid_days: 'paid_days', basic: 'basic', hra: 'hra', da: 'da', conveyance_allowance: 'conveyance_allowance',
  overtime: 'overtime', pf_deduction: 'pf_deduction', esi_deduction: 'esi_deduction', pt_deduction: 'pt_deduction',
  tds_deduction: 'tds_deduction', other_deduction: 'other_deduction'
};

// getValue(name) returns the raw value. names: the figure fields to check.
// mustBePositive: fields that must be greater than 0 (e.g. basic of an arrear).
// requireAll: false for a bulk edit, where a blank field means "keep current".
// basicWhenPaid: Basic must be greater than 0 whenever Paid days is greater than 0.
function checkFigures(getValue, names, { mustBePositive = [], requireAll = true, basicWhenPaid = false } = {}) {
  for (const name of names) {
    const raw = getValue(name);
    const blank = raw === undefined || raw === null || String(raw).trim() === '';
    if (blank) {
      if (requireAll) return `${LABELS[name] || name} is required — enter 0 if there is nothing to enter`;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${LABELS[name] || name} must be a number`;
    if (n < 0) return `${LABELS[name] || name} cannot be negative`;
    if (mustBePositive.includes(name) && n <= 0) return `${LABELS[name] || name} must be greater than 0`;
  }
  if (basicWhenPaid && Number(getValue('paid_days')) > 0 && !(Number(getValue('basic')) > 0)) {
    return 'basic must be greater than 0 when paid_days is more than 0';
  }
  return null;
}

module.exports = { checkFigures };
