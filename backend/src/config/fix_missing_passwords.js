/**
 * One-time fix: any employee whose app_access is 'YES' but has no
 * password_hash at all. This happens when app_access is set directly via a
 * SQL UPDATE rather than through Employee Master's Add/Edit form or the
 * Active/Inactive toggle — those are the only places that know to issue a
 * password (the employee's own Employee ID) alongside granting access.
 * A direct SQL UPDATE has no way to generate that password hash, so it
 * leaves the employee with access "on" but nothing to actually log in with.
 *
 * This finds every employee in that state and gives them a proper
 * password — their own Employee ID, forced to change it at next sign-in —
 * exactly like the app itself would have done.
 *
 * SAFE TO RE-RUN: only touches rows where app_access = 'YES' AND
 * password_hash IS NULL. Anyone who already has a password (however it was
 * set) is left completely untouched.
 *
 * HOW TO RUN:
 *   cd backend
 *   node src/config/fix_missing_passwords.js
 */
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function fix() {
  const [rows] = await pool.query(
    `SELECT id, employee_id FROM employees WHERE app_access = 'YES' AND password_hash IS NULL`
  );

  if (!rows.length) {
    console.log('No employees found with App Access on but no password. Nothing to fix.');
    process.exit(0);
  }

  console.log(`Found ${rows.length} employee(s) with App Access on but no password — fixing:\n`);

  for (const row of rows) {
    const passwordHash = await bcrypt.hash(row.employee_id, 10);
    await pool.query(
      `UPDATE employees SET password_hash = ?, must_change_password = 1 WHERE id = ?`,
      [passwordHash, row.id]
    );
    console.log(`  ${row.employee_id}: password set to their Employee ID.`);
  }

  console.log(`\nDone. ${rows.length} employee(s) fixed — they can now sign in with their Employee ID as both username and password, and will be asked to set a new one.`);
  process.exit(0);
}

fix().catch((err) => {
  console.error('Fix failed:', err.message);
  process.exit(1);
});
