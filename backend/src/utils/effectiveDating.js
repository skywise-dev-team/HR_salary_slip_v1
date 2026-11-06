// Effective-dated employee and establishment details.
//
// Every time an employee's or an establishment's slip-relevant details are
// saved, a dated "version" is kept (employee_versions / establishment_versions).
// A salary record then uses the version that was in force for ITS pay month:
//
//   a change effective 06-08-2026
//     July 2026 salary data   -> unchanged (old values)
//     August 2026 onwards     -> new values
//
// The rule is month-level: a version applies to a pay month when its
// effective date falls on or before the LAST day of that month. A pay month
// that is earlier than the very first version uses that first version.
const pool = require('../config/db');

const KINDS = {
  employee: {
    table: 'employee_versions', fk: 'employee_id', source: 'employees', salaryCol: 'employee_id',
    fields: ['full_name', 'relative_name', 'relation', 'designation', 'uan', 'bank_account_no']
  },
  establishment: {
    table: 'establishment_versions', fk: 'establishment_id', source: 'establishments', salaryCol: 'establishment_id',
    fields: ['name', 'address', 'signatory_name', 'logo_path', 'signature_path']
  }
};

const pad = (n) => String(n).padStart(2, '0');

// Accepts 'YYYY-MM-DD' (or a longer ISO string), a Date, or nothing (= today).
function normalizeDate(input) {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input)) return input.slice(0, 10);
  const d = input instanceof Date && !Number.isNaN(input.getTime()) ? input : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Last calendar day of a pay month, as 'YYYY-MM-DD'.
function periodEnd(month, year) {
  const m = Number(month);
  const y = Number(year);
  return `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
}

// versions: oldest first. Of the versions whose effective date is on/before
// `day`, the one SAVED most recently wins (the latest change made); when two
// were saved in the same instant the later effective date wins. A day earlier
// than every version uses the oldest one.
function pickVersion(versions, day) {
  let chosen = null;
  for (const v of versions) {
    if (v.eff > day) continue;
    if (!chosen || (v.saved || 0) > (chosen.saved || 0) || ((v.saved || 0) === (chosen.saved || 0) && v.eff > chosen.eff)) chosen = v;
  }
  return chosen || versions[0];
}

async function loadVersions(db, kind, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { table, fk, fields } = KINDS[kind];
  const [rows] = await db.query(
    `SELECT ${fk} AS owner, DATE_FORMAT(effective_from, '%Y-%m-%d') AS eff, UNIX_TIMESTAMP(created_at) AS saved, ${fields.join(', ')}
     FROM ${table} WHERE ${fk} IN (?) ORDER BY effective_from`,
    [ids]
  );
  for (const r of rows) {
    const key = String(r.owner);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
const empPart = (v) => pick(v, KINDS.employee.fields);
const estPart = (v) => ({
  establishment_name: v.name ?? null,
  ...pick(v, ['address', 'signatory_name', 'logo_path', 'signature_path'])
});
const stable = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));

// The snapshot to freeze onto a salary record for this employee,
// establishment and pay month. Falls back to the live master rows for an
// employee/establishment that has no versions yet.
// `asOfDay` ('YYYY-MM-DD') picks the details in force on that exact day
// (used for arrear slips, by their date of issue); without it the last day
// of the pay month is used.
async function captureSnapshotAt(employeeId, establishmentId, month, year, db = pool, asOfDay = null) {
  const end = asOfDay || periodEnd(month, year);
  const [[empLive]] = await db.query(
    `SELECT employee_id AS emp_code, full_name, relative_name, relation, designation, uan, bank_account_no
     FROM employees WHERE id = ?`, [employeeId]
  );
  const [[estLive]] = await db.query(
    `SELECT name AS establishment_name, address, signatory_name, logo_path, signature_path
     FROM establishments WHERE id = ?`, [establishmentId]
  );
  const empV = (await loadVersions(db, 'employee', [employeeId])).get(String(employeeId));
  const estV = (await loadVersions(db, 'establishment', [establishmentId])).get(String(establishmentId));
  const emp = empV ? { emp_code: empLive?.emp_code, ...empPart(pickVersion(empV, end)) } : empLive;
  const est = estV ? estPart(pickVersion(estV, end)) : estLive;
  return JSON.stringify({ ...emp, ...est });
}

// Rebuilds the frozen snapshot of every salary record of this employee /
// establishment whose pay month is on or after the effective month. Records
// of earlier months are never touched. A slip whose content actually changed
// has its "downloaded" flag reset, same as any other edit to a record.
async function restamp(db, kind, id, effectiveDate) {
  const { salaryCol } = KINDS[kind];
  const [y, m] = effectiveDate.split('-').map(Number);
  const [rows] = await db.query(
    `SELECT sd.id, sd.employee_id, sd.establishment_id, sd.period_month, sd.period_year, sd.slip_snapshot,
            e.employee_id AS emp_code
     FROM salary_data sd JOIN employees e ON e.id = sd.employee_id
     WHERE sd.${salaryCol} = ? AND (sd.period_year * 12 + sd.period_month) >= ?`,
    [id, y * 12 + m]
  );
  if (!rows.length) return 0;

  const empVersions = await loadVersions(db, 'employee', [...new Set(rows.map((r) => r.employee_id))]);
  const estVersions = await loadVersions(db, 'establishment', [...new Set(rows.map((r) => r.establishment_id))]);

  let changed = 0;
  for (const r of rows) {
    const empV = empVersions.get(String(r.employee_id));
    const estV = estVersions.get(String(r.establishment_id));
    if (!empV && !estV) continue;
    const end = periodEnd(r.period_month, r.period_year);
    let base = r.slip_snapshot;
    if (typeof base === 'string') { try { base = JSON.parse(base); } catch { base = null; } }
    const next = {
      ...(base || {}),
      emp_code: (base && base.emp_code) || r.emp_code,
      ...(empV ? empPart(pickVersion(empV, end)) : {}),
      ...(estV ? estPart(pickVersion(estV, end)) : {})
    };
    if (base && stable(base) === stable(next)) continue;
    await db.query('UPDATE salary_data SET slip_snapshot = ?, downloaded = 0 WHERE id = ?', [JSON.stringify(next), r.id]);
    changed++;
  }
  return changed;
}

// Call right AFTER the master row (employees / establishments) has been
// created or updated. Compares it with the version in force on the
// effective date; when anything slip-relevant differs (or there is no
// version yet) it stores a new version at that date and re-stamps the
// affected salary records. A save that changed nothing slip-relevant (for
// example only an app-access or status change) does nothing.
async function recordVersion(db, kind, id, effectiveDateInput) {
  const cfg = KINDS[kind];
  const effectiveDate = normalizeDate(effectiveDateInput);
  const [[current]] = await db.query(`SELECT ${cfg.fields.join(', ')} FROM ${cfg.source} WHERE id = ?`, [id]);
  if (!current) return { saved: false, restamped: 0 };

  const versions = (await loadVersions(db, kind, [id])).get(String(id)) || [];
  const cols = cfg.fields.join(', ');
  const placeholders = cfg.fields.map(() => '?').join(', ');
  const updates = cfg.fields.map((f) => `${f} = VALUES(${f})`).join(', ');
  const same = (a, b) => stable({ x: a ?? null }) === stable({ x: b ?? null });

  // What this save actually changes, measured against the details in force
  // on the effective date.
  const inForce = versions.length ? pickVersion(versions, effectiveDate) : null;
  const changedFields = inForce ? cfg.fields.filter((f) => !same(inForce[f], current[f])) : cfg.fields;
  if (inForce && !changedFields.length) return { saved: false, restamped: 0 };

  // Every change is kept exactly as saved (nothing older is edited). Which
  // one a slip uses is decided when the slip is built: of the versions
  // effective on or before the slip's date, the most recently SAVED wins.
  await db.query(
    `INSERT INTO ${cfg.table} (${cfg.fk}, effective_from, ${cols}) VALUES (?, ?, ${placeholders})
     ON DUPLICATE KEY UPDATE ${updates}, created_at = CURRENT_TIMESTAMP`,
    [id, effectiveDate, ...cfg.fields.map((f) => current[f] ?? null)]
  );
  const restamped = await restamp(db, kind, id, effectiveDate);
  return { saved: true, restamped };
}

module.exports = { recordVersion, captureSnapshotAt, restamp, normalizeDate, periodEnd, pickVersion };
