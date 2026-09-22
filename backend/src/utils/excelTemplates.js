const ExcelJS = require('exceljs');

// Builds a simple template workbook: a header row (bold) plus one example
// row underneath so the person uploading knows the expected format, then
// streams it as an .xlsx download.
//
// `validations` is an array of { column, values } where `column` matches a
// header name and `values` is the list of allowed strings — applied as a
// real Excel dropdown (data validation) down a generous number of rows so
// people filling in many rows still get the dropdown without re-copying it.
// Uses worksheet.dataValidations.add() with one explicit range per column
// (not a per-cell loop) so the file has exactly one clean validation rule
// per column instead of risking overlapping/duplicated ranges that can make
// Excel show a "we found a problem with some content" repair prompt.
//
// IMPORTANT: the finished workbook is built into an in-memory buffer via
// writeBuffer() and sent in one shot, rather than piping workbook.xlsx.write()
// directly into the Express response stream. Streaming straight into `res`
// is a known corruption source for ExcelJS (the file's shared-strings table
// can end up scrambled if the write gets interleaved with anything else on
// that response), which manifested here as garbled example-row text and
// dropdowns silently missing entirely.
async function sendTemplate(res, filename, headers, exampleRow, validations = []) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Template');

  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.columns = headers.map((h) => ({ width: Math.max(h.length + 4, 14) }));

  if (exampleRow) sheet.addRow(exampleRow);

  const LAST_ROW = 500;
  let listSheet = null;
  let listSheetColIndex = 0;

  validations.forEach(({ column, values }) => {
    const colIndex = headers.indexOf(column) + 1; // 1-based
    if (colIndex < 1 || !values?.length) return;

    const colLetter = sheet.getColumn(colIndex).letter;
    const range = `${colLetter}2:${colLetter}${LAST_ROW}`;
    const inlineFormula = `"${values.join(',')}"`;

    // Excel's inline list formula is capped at 255 characters — fall back to
    // a hidden reference sheet for longer lists (e.g. many establishment
    // codes) instead of silently producing a broken/truncated dropdown.
    if (inlineFormula.length <= 255) {
      sheet.dataValidations.add(range, {
        type: 'list',
        allowBlank: true,
        formulae: [inlineFormula],
        showErrorMessage: true,
        errorTitle: 'Invalid value',
        error: `Please choose one of: ${values.join(', ')}`
      });
    } else {
      if (!listSheet) listSheet = workbook.addWorksheet('Lists', { state: 'veryHidden' });
      listSheetColIndex += 1;
      const listColLetter = listSheet.getColumn(listSheetColIndex).letter;
      values.forEach((v, i) => { listSheet.getCell(`${listColLetter}${i + 1}`).value = v; });
      sheet.dataValidations.add(range, {
        type: 'list',
        allowBlank: true,
        formulae: [`Lists!$${listColLetter}$1:$${listColLetter}$${values.length}`],
        showErrorMessage: true,
        errorTitle: 'Invalid value',
        error: 'Please choose a value from the dropdown list'
      });
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}

// Streams an .xlsx populated with real data rows (an export, not a blank
// template) — a bold header row followed by one row per record. Same
// writeBuffer()-then-send-atomically approach as sendTemplate above, for the
// same corruption-avoidance reason.
async function sendDataExport(res, filename, headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');

  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.columns = headers.map((h) => ({ width: Math.max(h.length + 4, 14) }));

  rows.forEach((row) => sheet.addRow(row));

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}

module.exports = { sendTemplate, sendDataExport };
