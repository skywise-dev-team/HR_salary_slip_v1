// Scans an entire worksheet for blank cells in required columns BEFORE any
// database write happens. Used by every bulk Excel import (Upload Salary
// Data, Employees, Users) to enforce: if any cell in any required column of
// any non-empty row is blank, the WHOLE upload is rejected and nothing is
// saved — not just that one row skipped.
//
// A row that is entirely empty (no value in any column at all) is treated
// as an unused trailing row and ignored, not as a null-value violation —
// only a row that has *some* data but is missing a required cell counts.
//
// `numericColumns` (optional) lists which of the required columns must also
// parse as a valid finite number, not just be non-blank — e.g. salary
// figures, where non-numeric text like "N/A" is just as much a problem as
// a blank cell, since it would otherwise silently become 0 downstream.
//
// Returns an array of one string per bad row, e.g. "Row 3: period_month
// (blank), da (not a number: \"N/A\")". An empty array means the sheet is
// clean and the import may proceed.
// `extraRowValidator(row, colIndex)`, if given, runs only once a row has
// passed the blank/numeric checks above — it should return an error string
// (e.g. "period_month must be between 1 and 12") or null/undefined when the
// row is fine. Lets a caller add its own domain-specific range/format rules
// (out of scope for this generic blank-cell checker) without a second pass
// over the sheet.
function findNullCellProblems(sheet, colIndex, requiredColumns, numericColumns = [], extraRowValidator = null) {
  const problems = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;

    const badColumns = [];
    requiredColumns.forEach((name) => {
      const idx = colIndex(name);
      if (idx === -1) { badColumns.push(`${name} (column missing)`); return; }
      const raw = row.getCell(idx).value;
      if (raw == null || String(raw).trim() === '') { badColumns.push(`${name} (blank)`); return; }
      if (numericColumns.includes(name) && !Number.isFinite(Number(raw))) {
        badColumns.push(`${name} (not a number: "${raw}")`);
      }
    });

    if (!badColumns.length && extraRowValidator) {
      const extraError = extraRowValidator(row, colIndex);
      if (extraError) badColumns.push(extraError);
    }

    if (badColumns.length) problems.push(`Row ${r}: ${badColumns.join(', ')}`);
  }
  return problems;
}

// Builds the rejection message and truncates a very long problem list so
// the error response itself doesn't become unreasonably huge for a file
// with thousands of bad rows. Generic on purpose — `problems` may mix
// several different kinds of issues (blank cells, invalid periods,
// all-zero rows, duplicate rows), not just null-value ones.
function nullCellErrorMessage(problems) {
  const shown = problems.slice(0, 20);
  const more = problems.length - shown.length;
  return (
    `Upload cancelled — nothing was saved. Fix the following and re-upload:\n` +
    shown.join('\n') +
    (more > 0 ? `\n...and ${more} more issue(s)` : '')
  );
}

module.exports = { findNullCellProblems, nullCellErrorMessage };
