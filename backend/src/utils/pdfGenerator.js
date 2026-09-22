const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONTS_DIR, 'Carlito-Regular.ttf');
const FONT_BOLD = path.join(FONTS_DIR, 'Carlito-Bold.ttf');
const FONT_BOLD_ITALIC = path.join(FONTS_DIR, 'Carlito-BoldItalic.ttf');

const MM = 2.834645669; // points per millimetre

// ---------------------------------------------------------------
// Formatting helpers (ported 1:1 from the prototype's inr()/amountWords())
// ---------------------------------------------------------------

function formatINR(amount) {
  const n = Math.round(Number(amount) || 0);
  const s = String(Math.abs(n));
  const last = s.slice(-3);
  const rest = s.slice(0, -3);
  const g = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last : last;
  return (n < 0 ? '-' : '') + g;
}

const rupees = (v) => `\u20B9${formatINR(v)}`;

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const twoWords = (x) => (x < 20 ? ONES[x] : TENS[Math.floor(x / 10)] + (x % 10 ? ' ' + ONES[x % 10] : ''));
const threeWords = (x) => {
  const h = Math.floor(x / 100), r = x % 100;
  return (h ? ONES[h] + ' Hundred' + (r ? ' and ' : '') : '') + (r ? twoWords(r) : '');
};

// Indian numbering (crore/lakh/thousand), matching the prototype's amountWords()
function amountWords(amount) {
  let n = Math.round(Math.abs(Number(amount) || 0));
  if (!n) return 'Rupees Zero Only';
  const parts = [];
  const cr = Math.floor(n / 10000000); n %= 10000000;
  const la = Math.floor(n / 100000); n %= 100000;
  const th = Math.floor(n / 1000); n %= 1000;
  if (cr) parts.push(`${twoWords(cr)} Crore`);
  if (la) parts.push(`${twoWords(la)} Lakh`);
  if (th) parts.push(`${twoWords(th)} Thousand`);
  if (n) parts.push(threeWords(n));
  return `Rupees ${parts.join(' ')} Only`;
}

function maskKeepLast4(value) {
  const str = String(value || '').trim();
  if (!str) return '\u2014';
  if (str.length <= 4) return str;
  return '*'.repeat(str.length - 4) + str.slice(-4);
}

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

const dash = (v) => (v === null || v === undefined || v === '' ? '\u2014' : String(v));

// Auto-crops an image down to its actual visible content — removing any
// surrounding transparent/whitespace padding — before it ever reaches
// drawImageCentered(). Without this, a logo or signature file that has a
// lot of empty margin around the real content (very common with signature
// scans/exports) shrinks that padding right along with everything else
// when scaled into the fixed display box, so the actual visible ink ends
// up a tiny fraction of the box — exactly what made one establishment's
// signature look barely-there while another's, uploaded with tighter
// cropping, looked bold and clear. Returns a PNG Buffer, or null if the
// file is missing/unreadable (falls back to the original file in that case
// rather than failing the whole slip).
async function trimImageToBuffer(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return await sharp(filePath).trim().png().toBuffer();
  } catch {
    try { return fs.readFileSync(filePath); } catch { return null; }
  }
}

// Draws an image scaled to fit inside a fixed box (boxW x boxH) and centered
// within it both horizontally and vertically — so every establishment's
// logo/signature lands at the exact same size and position on the slip
// regardless of the aspect ratio or pixel dimensions of the file they
// uploaded. pdfkit's own `fit` option only anchors the scaled image at the
// box's top-left corner, which visibly shifts a wide logo vs. a square one
// even inside an identical box; reading the image's real dimensions with
// doc.openImage() and centering manually avoids that inconsistency.
function drawImageCentered(doc, image, boxX, boxY, boxW, boxH) {
  const img = doc.openImage(image);
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = boxX + (boxW - w) / 2;
  const y = boxY + (boxH - h) / 2;
  doc.image(image, x, y, { width: w, height: h });
}

// ---------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------

// The Form-XVI layout's five earnings columns (Basic, D.A., HRA, Conveyance
// Allowance, Overtime) and five deduction columns (PF, ESI, P-Tax, TDS,
// Others) each map to their own dedicated salary_data column — da,
// conveyance_allowance, overtime, pt_deduction, tds_deduction, other_deduction.
//
// PAGE LAYOUT: the physical sheet is A4 portrait, but each slip is laid out
// wide (using the full A4 width) and two identical copies are stacked one
// above the other — one A4 portrait sheet, cut in half, yields two complete
// slips with no wasted paper, and the printer dialog no longer shows a
// narrow page with blank space to its right.
//
// Returns the finished PDF as a Buffer — nothing here ever touches disk.
// This is generated fresh every time it's called (a preview, a download,
// one file inside a bulk ZIP) rather than saved anywhere, by design.
async function generateSalarySlipPdf(record, secondRecord = null) {
  // Trim logo/signature images down to their real visible content BEFORE
  // any drawing happens — pdfkit's drawing calls below are synchronous, so
  // this async preprocessing has to finish first, with the resulting
  // Buffers stashed onto each record for drawSlip() to use in place of a
  // raw file path.
  record._logoBuf = await trimImageToBuffer(record.logo_path);
  record._sigBuf = await trimImageToBuffer(record.signature_path);
  if (secondRecord) {
    secondRecord._logoBuf = await trimImageToBuffer(secondRecord.logo_path);
    secondRecord._sigBuf = await trimImageToBuffer(secondRecord.signature_path);
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('reg', FONT_REGULAR);
    doc.registerFont('bold', FONT_BOLD);
    doc.registerFont('bolditalic', FONT_BOLD_ITALIC);

    // Defensively disable ligature substitution for every text() call in this
    // document. Some pdfkit/fontkit + Carlito combinations have been seen to
    // drop a letter around "ti"/"tt" sequences (e.g. "Occupational" ->
    // "Occupatonal", "attendance" -> "atendance") when the font's ligature
    // table is applied during shaping — on a legal wage slip that's not an
    // acceptable risk, so ligatures are turned off outright rather than
    // trusting a specific library version to shape them correctly.
    const originalText = doc.text.bind(doc);
    doc.text = (str, x, y, options = {}) =>
      originalText(str, x, y, { features: ['-liga', '-clig', '-dlig'], ...options });

    const sliceH = doc.page.height / 2;
    drawSlip(doc, record, 0, sliceH);
    // A single downloaded/printed slip leaves the bottom half of the page
    // blank rather than repeating the same slip — the two-per-page layout
    // is for printing two DIFFERENT employees' slips together (pass
    // secondRecord to fill the bottom half); it does not duplicate one.
    if (secondRecord) {
      doc.moveTo(0, sliceH).lineTo(doc.page.width, sliceH).lineWidth(0.5).dash(3, { space: 2 }).stroke('#AAAAAA');
      doc.undash();
      drawSlip(doc, secondRecord, sliceH, sliceH);
    }

    doc.end();
  });
}

// Draws one complete slip inside the vertical band [originY, originY+sliceH),
// using the full page width.
function drawSlip(doc, record, originY, sliceH) {
  const marginX = 8 * MM;
  const contentWidth = doc.page.width - marginX * 2;
  let y = originY + 4 * MM;

  const FS = 11;
  const VOFF = FS * 0.5;
  const PAD = 4;

  // --- Header: logo (if any) + centered FORM XVI heading block ---
  // Fully adaptive to whatever size/shape logo an establishment uploads:
  // the logo is anchored at the top-left (marginX, top of the header area)
  // and vertically centered against the 3-line heading block specifically —
  // not against a fixed row height — and the header area's own height
  // expands to whichever is taller (the heading text or the logo) so a
  // large logo can never overlap the rule line or the content below it,
  // regardless of its dimensions.
  const headingTextHeight = 10.5 + 10.5 + 16; // 3 lines' worth of the increments used below

  let logoW = 0, logoH = 0;
  if (record._logoBuf) {
    try {
      const img = doc.openImage(record._logoBuf);
      const maxLogoW = 40 * MM, maxLogoH = 22 * MM; // generous cap; actual size then centers against the heading
      const scale = Math.min(maxLogoW / img.width, maxLogoH / img.height);
      logoW = img.width * scale;
      logoH = img.height * scale;
    } catch { /* ignore bad image */ }
  }

  const headerTop = y;
  const headerContentHeight = Math.max(headingTextHeight, logoH);
  const headerCenterY = headerTop + headerContentHeight / 2;

  if (record._logoBuf && logoW && logoH) {
    try { doc.image(record._logoBuf, marginX, headerCenterY - logoH / 2, { width: logoW, height: logoH }); } catch { /* ignore bad image */ }
  }

  let hy = headerCenterY - headingTextHeight / 2;
  doc.font('bolditalic').fontSize(8).text('FORM \u2013 XVI  (See Rule 72(2))', marginX, hy, { width: contentWidth, align: 'center' });
  hy += 10.5;
  doc.font('bolditalic').fontSize(8).text('Occupational Safety, Health and Working Conditions Code, 2020', marginX, hy, { width: contentWidth, align: 'center' });
  hy += 10.5;
  doc.font('bold').fontSize(13).text('WAGE / SALARY SLIP', marginX, hy, { width: contentWidth, align: 'center' });
  hy += 16; // clears the 13pt title's full line height before the rule below

  y = Math.max(headerTop + headerContentHeight + 3, hy);
  doc.moveTo(marginX, y).lineTo(marginX + contentWidth, y).lineWidth(1).stroke('#000');
  y += 4;

  // --- Date of issue / Period ---
  const issueDate = record.issueDate || formatDate(new Date());
  const period = `${MONTHS[record.period_month]}-${record.period_year}`;

  doc.font('reg').fontSize(FS).text('Date of issue: ', marginX, y, { lineBreak: false });
  const dateLabelW = doc.widthOfString('Date of issue: ');
  doc.font('bold').fontSize(FS).text(issueDate, marginX + dateLabelW, y, { lineBreak: false });

  const periodLabel = 'Period: ';
  doc.font('reg').fontSize(FS);
  const periodLabelW = doc.widthOfString(periodLabel);
  doc.font('bold').fontSize(FS);
  const periodValueW = doc.widthOfString(period);
  const periodStartX = marginX + contentWidth - periodLabelW - periodValueW;
  doc.font('reg').fontSize(FS).text(periodLabel, periodStartX, y, { lineBreak: false });
  doc.font('bold').fontSize(FS).text(period, periodStartX + periodLabelW, y, { lineBreak: false });
  y += FS + 3;

  // --- Establishment ---
  doc.font('reg').fontSize(FS).text('Name of the Establishment : ', marginX, y, { lineBreak: false });
  const estLabelW = doc.widthOfString('Name of the Establishment : ');
  doc.font('bold').fontSize(FS).text(record.establishment_name || '', marginX + estLabelW, y, { lineBreak: false });
  y += FS + 3;
  if (record.address) {
    doc.font('reg').fontSize(FS);
    const addrText = `Address : ${record.address}`;
    const h = doc.heightOfString(addrText, { width: contentWidth });
    doc.text(addrText, marginX, y, { width: contentWidth });
    y += h + 2;
  } else {
    y += 2;
  }
  y += 2;

  // --- Table ---
  const col1W = 8 * MM;
  const col2W = (contentWidth - col1W) / 2;
  const col3W = contentWidth - col1W - col2W;
  const col1X = marginX;
  const col2X = marginX + col1W;
  const col3X = marginX + col1W + col2W;

  // Every row (including each line inside row 8, and the words row) shares
  // this one height — sized off row 1's needs, per spec.
  const rowH = FS + 3;

  const wordsText = amountWords(record.net_pay);
  const wordsHeight = Math.max(rowH, doc.font('bold').fontSize(FS).heightOfString(wordsText, { width: col3W - 8 }) + 6);

  const simpleRows = [
    ['1', 'Employee code', dash(record.emp_code)],
    ['2', 'Name of the Employee', dash(record.full_name)],
    ['3', 'Father\u2019s/Mother\u2019s/Spouse\u2019s Name', dash(record.relative_name)],
    ['4', 'Designation', dash(record.designation)],
    ['5', 'UAN', dash(record.uan)],
    ['6', 'Bank Account Number', maskKeepLast4(record.bank_account_no)],
    ['7', 'Total attendance / unit of work done', dash(record.paid_days)]
  ];

  const combinedBlockH = rowH * 8; // full-width label + header + 5 items + total, all equal height now

  const rowHeights = [
    ...simpleRows.map(() => rowH),
    combinedBlockH,
    rowH,
    wordsHeight
  ];
  const tableTop = y;
  const tableHeight = rowHeights.reduce((a, b) => a + b, 0);

  doc.lineWidth(1);
  doc.rect(marginX, tableTop, contentWidth, tableHeight).stroke('#000');
  doc.moveTo(col2X, tableTop).lineTo(col2X, tableTop + tableHeight).stroke('#000');

  // Row 8 merges columns 2+3 for its own full-width label line, so the
  // usual col2|col3 divider must skip that row's span (custom dividers for
  // its Earnings/Deductions sub-layout are drawn separately below).
  const row8Top = tableTop + rowHeights.slice(0, 7).reduce((a, b) => a + b, 0);
  const row8Bottom = row8Top + rowHeights[7];
  doc.moveTo(col3X, tableTop).lineTo(col3X, row8Top).stroke('#000');
  doc.moveTo(col3X, row8Bottom).lineTo(col3X, tableTop + tableHeight).stroke('#000');

  let rowY = tableTop;
  const hLine = (yy) => { doc.lineWidth(1); doc.moveTo(marginX, yy).lineTo(marginX + contentWidth, yy).stroke('#000'); };

  // Plain rows 1–7: bold label, regular left-aligned value.
  simpleRows.forEach(([num, label, value], i) => {
    const h = rowHeights[i];
    const labelH = doc.font('bold').fontSize(FS).heightOfString(label, { width: col2W - PAD * 2 });
    const labelY = rowY + (h - labelH) / 2; // true vertical centering, even when the label wraps to 2 lines
    doc.font('reg').fontSize(FS).text(num, col1X, rowY + h / 2 - VOFF, { width: col1W, align: 'center' });
    doc.font('bold').fontSize(FS).text(label, col2X + PAD, labelY, { width: col2W - PAD * 2 });
    doc.font('reg').fontSize(FS).text(String(value), col3X + PAD, rowY + h / 2 - VOFF, { width: col3W - PAD * 2 });
    rowY += h;
    hLine(rowY);
  });

  // Row 8 — Rate of Wages / Salary payable: the label sits on its own
  // full-width line (columns 2+3 merged), with Earnings and Deductions
  // as two EQUAL halves underneath it, split at col3X — the same X
  // position as the col2|col3 divider used by every other row. No
  // separate serial numbers for the individual lines or for Gross Wages/
  // Total Deductions — those are just the bold last line of their column.
  // Every one of the 8 lines here is the same height as row 1.
  {
    const h = rowHeights[7];
    const mergedX = col2X;
    const mergedW = col2W + col3W;

    doc.font('reg').fontSize(FS).text('8', col1X, rowY + h / 2 - VOFF, { width: col1W, align: 'center' });

    doc.font('bold').fontSize(FS).text('Rate of Wages / Salary payable', mergedX + PAD, rowY + rowH / 2 - VOFF, { width: mergedW - PAD * 2 });

    const midX = col3X;
    const halfW = mergedW / 2;
    const earningsLabelW = halfW * 0.6;
    const earningsValueW = halfW - earningsLabelW;
    const deductionsLabelW = halfW * 0.5;
    const deductionsValueW = halfW - deductionsLabelW;

    const earnings = [
      ['Basic', rupees(record.basic)],
      ['D.A.', rupees(record.da)],
      ['HRA', rupees(record.hra)],
      ['Conveyance Allowance', rupees(record.conveyance_allowance)],
      ['Overtime', rupees(record.overtime)]
    ];
    const deductions = [
      ['PF', rupees(record.pf_deduction)],
      ['ESI', rupees(record.esi_deduction)],
      ['P-Tax', rupees(record.pt_deduction)],
      ['TDS', rupees(record.tds_deduction)],
      ['Others', rupees(record.other_deduction)]
    ];

    const drawHalf = (sideX, sideW, sideLabelW, sideValueW, headerText, items, totalLabel, totalValue) => {
      doc.font('bold').fontSize(FS).text(headerText, sideX, rowY + rowH + rowH / 2 - VOFF, { width: sideW, align: 'center' });
      items.forEach(([itemLabel, itemValue], i) => {
        const iy = rowY + rowH * (i + 2);
        doc.font('reg').fontSize(FS).text(itemLabel, sideX + PAD, iy + rowH / 2 - VOFF, { width: sideLabelW - PAD * 2 });
        doc.font('reg').fontSize(FS).text(itemValue, sideX + sideLabelW + PAD, iy + rowH / 2 - VOFF, { width: sideValueW - PAD * 2, align: 'right' });
      });
      const ty = rowY + rowH * 7;
      doc.font('bold').fontSize(FS).text(totalLabel, sideX + PAD, ty + rowH / 2 - VOFF, { width: sideLabelW - PAD * 2 });
      doc.font('bold').fontSize(FS).text(totalValue, sideX + sideLabelW + PAD, ty + rowH / 2 - VOFF, { width: sideValueW - PAD * 2, align: 'right' });
      // item-label | item-value divider — starts below the EARNINGS/
      // DEDUCTIONS header line, not through it.
      doc.moveTo(sideX + sideLabelW, rowY + rowH * 2).lineTo(sideX + sideLabelW, rowY + h).lineWidth(1).stroke('#000');
    };

    drawHalf(mergedX, halfW, earningsLabelW, earningsValueW, 'EARNINGS', earnings, 'Gross Wages / Salary payable', rupees(record.gross_earnings));
    drawHalf(midX, halfW, deductionsLabelW, deductionsValueW, 'DEDUCTIONS', deductions, 'Total deduction', rupees(record.total_deduction));

    // Divider between the Earnings and Deductions halves (starts below the full-width label line)
    doc.moveTo(midX, rowY + rowH).lineTo(midX, rowY + h).lineWidth(1).stroke('#000');
    // Horizontal divider under the full-width label line, then between each of the 7 lines below it
    for (let i = 1; i < 8; i++) {
      const iy = rowY + rowH * i;
      doc.moveTo(mergedX, iy).lineTo(mergedX + mergedW, iy).lineWidth(1).stroke('#000');
    }

    rowY += h;
    hLine(rowY);
  }

  // Row 9 — Net Wages / Salary amount paid: plain style like rows 1–7, bold value
  {
    const h = rowHeights[8];
    doc.font('reg').fontSize(FS).text('9', col1X, rowY + h / 2 - VOFF, { width: col1W, align: 'center' });
    doc.font('bold').fontSize(FS).text('Net Wages / Salary amount paid', col2X + PAD, rowY + h / 2 - VOFF, { width: col2W - PAD * 2 });
    doc.font('bold').fontSize(FS).text(rupees(record.net_pay), col3X + PAD, rowY + h / 2 - VOFF, { width: col3W - PAD * 2 });
    rowY += h;
    hLine(rowY);
  }

  // Row 10 — Net Wages / Salary amount paid (in words): plain style like rows 1–7, bold value
  {
    const h = rowHeights[9];
    const labelH2 = doc.font('bold').fontSize(FS).heightOfString('Net Wages / Salary amount paid (in words)', { width: col2W - PAD * 2 });
    const valueH = doc.font('bold').fontSize(FS).heightOfString(wordsText, { width: col3W - PAD * 2 });
    doc.font('reg').fontSize(FS).text('10', col1X, rowY + h / 2 - VOFF, { width: col1W, align: 'center' });
    doc.font('bold').fontSize(FS).text('Net Wages / Salary amount paid (in words)', col2X + PAD, rowY + (h - labelH2) / 2, { width: col2W - PAD * 2 });
    doc.font('bold').fontSize(FS).text(wordsText, col3X + PAD, rowY + (h - valueH) / 2, { width: col3W - PAD * 2, lineGap: 1 });
    rowY += h;
  }

  y = rowY + 9 * MM;

  // --- Signature ---
  const signW = 44 * MM;
  const signRight = marginX + contentWidth;
  const signLeft = signRight - signW;
  const signCenterX = (signLeft + signRight) / 2;
  if (record._sigBuf) {
    const imgW = 20 * MM, imgH = 8 * MM; // small enough to clear the table above given the 9mm gap
    try {
      drawImageCentered(doc, record._sigBuf, signCenterX - imgW / 2, y - imgH - 2, imgW, imgH);
    } catch { /* ignore bad image */ }
  }
  doc.moveTo(signLeft, y).lineTo(signRight, y).lineWidth(1).stroke('#000');
  let sy = y + 3;
  if (record.signatory_name) {
    doc.font('bold').fontSize(9).text(record.signatory_name, marginX, sy, { width: contentWidth, align: 'right' });
    sy += 11;
  }
  doc.font('reg').fontSize(9).text('Employer/Pay-in-charge signature', marginX, sy, { width: contentWidth, align: 'right' });

  // --- Footer ---
  const footerY = sy + 16;
  doc.moveTo(marginX, footerY - 4).lineTo(marginX + contentWidth, footerY - 4).lineWidth(0.75).stroke('#DDDDDD');
  doc.font('reg').fontSize(7).fillColor('#555555')
    .text(`Computer-generated Wages / Salary slip \u00b7 ${period}`, marginX, footerY, { width: contentWidth, align: 'center' });
  doc.fillColor('#000000');
}

module.exports = { generateSalarySlipPdf, formatINR, amountWords, formatDate };
