const pool = require('../config/db');

// Deletes activity_log rows older than 6 months, measured from when each
// entry was actually recorded (created_at).
async function cleanupOldActivityLogs() {
  const [result] = await pool.query(
    `DELETE FROM activity_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 6 MONTH)`
  );
  if (result.affectedRows) console.log(`Retention cleanup: removed ${result.affectedRows} activity log entr(y/ies) older than 6 months.`);
  return result.affectedRows;
}

async function runRetentionCleanup() {
  try {
    await cleanupOldActivityLogs();
  } catch (err) {
    console.error('Retention cleanup (activity log) failed:', err.message);
  }
}

module.exports = { runRetentionCleanup, cleanupOldActivityLogs };
