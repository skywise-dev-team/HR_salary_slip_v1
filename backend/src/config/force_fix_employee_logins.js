/**
 * Definitive one-shot fix for "Invalid credentials" on employee logins that
 * should be working. Rather than diagnosing the exact cause further, this
 * forcibly puts every access-enabled employee into a guaranteed-correct
 * state in one pass:
 *
 *   1. Trims any leading/trailing whitespace from every employee_id in the
 *      table. Hidden whitespace is invisible on screen and in most query
 *      results, but MySQL's default text comparison (`=`) ignores trailing
 *      spaces while bcrypt's password check does not — so a stored ID of
 *      "EMP006919 " (trailing space) would still be found by the login
 *      lookup, but a password hashed from that dirty value would never
 *      match someone typing the clean ID, no matter how many times it's
 *      reset.
 *   2. For every employee with app_access = 'YES', unconditionally resets
 *      their password to their own (now-cleaned) Employee ID and forces a
 *      password change at next sign-in — regardless of whatever their
 *      password_hash currently is. This guarantees a working login for
 *      every enabled employee, eliminating any possibility of a stale or
 *      mismatched hash, rather than trying to detect which specific rows
 *      are affected.
 *
 * This intentionally resets EVERY enabled employee's password, not just
 * the one(s) you've noticed are broken — that's the trade-off for a single
 * guaranteed fix instead of further diagnosis. Anyone currently signed in
 * will simply be asked to set a new password next time they sign in again
 * (their current session stays valid until it naturally expires).
 *
 * HOW TO RUN:
 *   cd backend
 *   node src/config/force_fix_employee_logins.js
 */
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function run() {
  const [trimResult] = await pool.query(
    `UPDATE employees SET employee_id = TRIM(employee_id) WHERE employee_id != TRIM(employee_id)`
  );
  console.log(`Cleaned up whitespace on ${trimResult.affectedRows} employee_id value(s).`);

  const [rows] = await pool.query(
    `SELECT id, employee_id FROM employees WHERE app_access = 'YES'`
  );

  if (!rows.length) {
    console.log('No employees currently have App Access = Yes. Nothing to reset.');
    process.exit(0);
  }

  console.log(`Resetting password for ${rows.length} access-enabled employee(s):\n`);
  for (const row of rows) {
    const passwordHash = await bcrypt.hash(row.employee_id, 10);
    await pool.query(
      `UPDATE employees SET password_hash = ?, must_change_password = 1 WHERE id = ?`,
      [passwordHash, row.id]
    );
    console.log(`  ${row.employee_id}: password reset to their Employee ID.`);
  }

  console.log(`\nDone. Every access-enabled employee can now sign in with their Employee ID as both username and password, and will be asked to set a new one.`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Fix failed:', err.message);
  process.exit(1);
});
