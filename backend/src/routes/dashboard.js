const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requireNotPendingPasswordChange } = require('../middleware/auth');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

router.get('/summary', async (req, res) => {
  const [[est]] = await pool.query('SELECT COUNT(*) AS count FROM establishments');
  const [[emp]] = await pool.query("SELECT COUNT(*) AS count FROM employees WHERE status='ACTIVE'");
  const [[users]] = await pool.query("SELECT COUNT(*) AS count FROM users WHERE status='ACTIVE'");
  const [[slips]] = await pool.query('SELECT COUNT(*) AS count FROM salary_data');
  const [recent] = await pool.query(
    `SELECT sd.period_month, sd.period_year, COUNT(*) AS records, SUM(sd.net_pay) AS total_net_pay
     FROM salary_data sd GROUP BY sd.period_year, sd.period_month
     ORDER BY sd.period_year DESC, sd.period_month DESC LIMIT 6`
  );

  res.json({
    establishments: est.count,
    activeEmployees: emp.count,
    activeUsers: users.count,
    slipsGenerated: slips.count,
    recentPeriods: recent
  });
});

module.exports = router;
