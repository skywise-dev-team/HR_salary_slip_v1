// Which establishments a signed-in staff account may work with.
//
//   req.user.estScope === null      -> no limit (the Admin role, or an account
//                                      given "all establishments")
//   req.user.estScope === [3, 7]    -> only those establishments; an empty list
//                                      means no establishment at all
//
// Employee self-service logins are never limited here - they only ever see
// their own slips, which is handled in salarySlips.js.
//
// Every list is filtered and every record is checked on the server, so a
// restricted account cannot reach another establishment by changing a
// request, only by being given access to it.
const pool = require('../config/db');

// Works out the scope for one staff account. `all` is users.all_establishments.
async function loadEstablishmentScope(userId, roleName, all) {
  if (roleName === 'Admin' || all) return null;
  const [rows] = await pool.query('SELECT establishment_id FROM user_establishments WHERE user_id = ?', [userId]);
  return rows.map((r) => Number(r.establishment_id));
}

const isRestricted = (req) => Array.isArray(req.user?.estScope);

const inScope = (req, establishmentId) =>
  !isRestricted(req) || req.user.estScope.includes(Number(establishmentId));

// Adds "<column> IN (...)" (or "1 = 0" when nothing is allowed) to a list of
// WHERE clauses. Does nothing for an unrestricted account.
function addScope(req, clauses, params, column) {
  if (!isRestricted(req)) return;
  if (!req.user.estScope.length) { clauses.push('1 = 0'); return; }
  clauses.push(`${column} IN (?)`);
  params.push(req.user.estScope);
}

// Sends the standard refusal.
function deny(res, message) {
  return res.status(403).json({ message: message || 'You do not have access to this establishment.' });
}

// True if the establishment is allowed; otherwise sends the refusal and returns false.
function allowEstablishment(req, res, establishmentId, message) {
  if (inScope(req, establishmentId)) return true;
  deny(res, message);
  return false;
}

// Establishment ids behind a list of ids from another table.
async function establishmentsOf(table, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return { found: [], missing: 0 };
  const [rows] = await pool.query(`SELECT id, establishment_id FROM ${table} WHERE id IN (?)`, [list]);
  return { found: rows, missing: list.length - rows.length };
}

// For a list of employees.id / salary_data.id values: true if every one of
// them belongs to an allowed establishment. Otherwise sends the refusal.
async function allowRecords(req, res, table, ids, message) {
  if (!isRestricted(req)) return true;
  const { found } = await establishmentsOf(table, ids);
  const blocked = found.filter((r) => !inScope(req, r.establishment_id)).length;
  if (!blocked) return true;
  deny(res, message || (blocked === 1
    ? 'This record belongs to an establishment you do not have access to.'
    : `${blocked} of the selected records belong to establishments you do not have access to.`));
  return false;
}

module.exports = { loadEstablishmentScope, isRestricted, inScope, addScope, deny, allowEstablishment, allowRecords, establishmentsOf };
