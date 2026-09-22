const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requireNotPendingPasswordChange } = require('../middleware/auth');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

// Every route here is scoped to req.user.id automatically — a person only
// ever sees their own notifications, never anyone else's, regardless of
// role. Employee Master logins never generate or receive notifications
// (the approval workflow only involves staff accounts), but there's no
// harm in these routes existing for them too — they'd simply always be empty.

router.get('/', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, approval_id, message, is_read, created_at FROM notifications
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
});

router.get('/unread-count', async (req, res) => {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0`,
    [req.user.id]
  );
  res.json({ count: row.count });
});

router.post('/:id/read', async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ message: 'Marked as read' });
});

router.post('/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.user.id]);
  res.json({ message: 'All marked as read' });
});

module.exports = router;
