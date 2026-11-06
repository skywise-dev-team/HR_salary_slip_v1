const express = require('express');
const asyncRouter = require('../utils/asyncRouter');
const pool = require('../config/db');
const { requireAuth, requireNotPendingPasswordChange } = require('../middleware/auth');
const { addScope } = require('../utils/establishmentScope');

const router = asyncRouter();
router.use(requireAuth);
router.use(requireNotPendingPasswordChange);

// Counts only cover the establishments the signed-in account has access to
// (everything, for the Admin role or an account given all establishments).
router.get('/summary', async (req, res) => {
  const estClauses = [];
  const estParams = [];
  addScope(req, estClauses, estParams, 'id');
  const [[est]] = await pool.query(
    `SELECT COUNT(*) AS count FROM establishments ${estClauses.length ? `WHERE ${estClauses.join(' AND ')}` : ''}`, estParams
  );

  const empClauses = ["status='ACTIVE'"];
  const empParams = [];
  addScope(req, empClauses, empParams, 'establishment_id');
  const [[emp]] = await pool.query(`SELECT COUNT(*) AS count FROM employees WHERE ${empClauses.join(' AND ')}`, empParams);

  const [[users]] = await pool.query("SELECT COUNT(*) AS count FROM users WHERE status='ACTIVE'");

  const sdClauses = [];
  const sdParams = [];
  addScope(req, sdClauses, sdParams, 'sd.establishment_id');
  const sdWhere = sdClauses.length ? `WHERE ${sdClauses.join(' AND ')}` : '';
  const [[slips]] = await pool.query(`SELECT COUNT(*) AS count FROM salary_data sd ${sdWhere}`, sdParams);
  const [recent] = await pool.query(
    `SELECT sd.period_month, sd.period_year, COUNT(*) AS records, SUM(sd.net_pay) AS total_net_pay
     FROM salary_data sd ${sdWhere} GROUP BY sd.period_year, sd.period_month
     ORDER BY sd.period_year DESC, sd.period_month DESC LIMIT 6`,
    sdParams
  );

  // Charts: last 12 pay periods (oldest first), active employees per establishment,
  // and active vs inactive employee split.
  const [trendDesc] = await pool.query(
    `SELECT sd.period_month, sd.period_year, COUNT(*) AS records, SUM(sd.net_pay) AS total_net_pay
     FROM salary_data sd ${sdWhere} GROUP BY sd.period_year, sd.period_month
     ORDER BY sd.period_year DESC, sd.period_month DESC LIMIT 12`,
    sdParams
  );
  const trend = trendDesc.reverse().map((r) => ({
    period_month: r.period_month, period_year: r.period_year,
    records: Number(r.records), total_net_pay: Number(r.total_net_pay || 0)
  }));

  const ebClauses = ["e.status='ACTIVE'"];
  const ebParams = [];
  addScope(req, ebClauses, ebParams, 'e.establishment_id');
  const [byEst] = await pool.query(
    `SELECT est.name, COUNT(*) AS employees
     FROM employees e JOIN establishments est ON est.id = e.establishment_id
     WHERE ${ebClauses.join(' AND ')}
     GROUP BY est.id, est.name ORDER BY employees DESC LIMIT 10`,
    ebParams
  );

  const stClauses = [];
  const stParams = [];
  addScope(req, stClauses, stParams, 'establishment_id');
  const [statusRows] = await pool.query(
    `SELECT status, COUNT(*) AS count FROM employees ${stClauses.length ? `WHERE ${stClauses.join(' AND ')}` : ''} GROUP BY status`,
    stParams
  );
  const statusCount = (s) => Number(statusRows.find((r) => r.status === s)?.count || 0);

  const [usersByRole] = await pool.query(
    `SELECT r.role_name AS name, COUNT(*) AS users
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status='ACTIVE' GROUP BY r.id, r.role_name ORDER BY users DESC`
  );

  res.json({
    usersByRole: usersByRole.map((r) => ({ name: r.name, users: Number(r.users) })),
    trend,
    employeesByEstablishment: byEst.map((r) => ({ name: r.name, employees: Number(r.employees) })),
    employeeStatus: { active: statusCount('ACTIVE'), inactive: statusCount('INACTIVE') },
    establishments: est.count,
    activeEmployees: emp.count,
    activeUsers: users.count,
    slipsGenerated: slips.count,
    recentPeriods: recent
  });
});

module.exports = router;
