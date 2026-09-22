const pool = require('../config/db');

// Records one staff-account action into activity_log. Never called for
// Employee Master logins (source: 'employee') — those can only ever view
// their own salary slip, so there is nothing meaningful to audit there;
// this exists purely to track staff (Admin/HR/etc.) usage of the app.
// Only ever call this for actions that actually change something — never
// for a page view, a preview, or a download.
//
// `req` is the Express request (already authenticated by requireAuth by
// the time any write route runs, so req.user is populated). `action` is a
// short fixed label (LOGIN, CREATE, UPDATE, DELETE, IMPORT, STATUS_CHANGE,
// PASSWORD_RESET, PASSWORD_CHANGE). `moduleKey` is one of the app's module
// keys, or null for actions not tied to a specific module (login, changing
// your own password). `description` is a short human-readable summary,
// e.g. "Updated employee EMP001234" or "Bulk imported 250 employee(s)".
//
// A logging failure is swallowed (and printed to the server console)
// rather than allowed to break the actual request it's attached to —
// losing one audit-log line is far preferable to failing a real save.
async function logActivity(req, action, moduleKey, description) {
  if (!req.user || req.user.source !== 'user') return;
  try {
    await pool.query(
      `INSERT INTO activity_log (user_id, performed_by, role_name, action, module_key, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, req.user.userId, req.user.roleName, action, moduleKey, description]
    );
  } catch (err) {
    console.error('Failed to write activity log:', err.message);
  }
}

// Same idea, for the one case that happens before req.user exists yet —
// a successful login itself. Takes the freshly-authenticated user's
// details directly instead of reading them off req.user.
async function logLogin(user) {
  try {
    await pool.query(
      `INSERT INTO activity_log (user_id, performed_by, role_name, action, module_key, description)
       VALUES (?, ?, ?, 'LOGIN', NULL, ?)`,
      [user.id, user.user_id, user.role_name, `Signed in`]
    );
  } catch (err) {
    console.error('Failed to write activity log:', err.message);
  }
}

module.exports = { logActivity, logLogin };
