const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'salary_slip',
  waitForConnections: true,
  // How many connections this one Node.js process may open to MySQL at
  // once. Was 10 — raised to give real headroom for genuinely heavy
  // simultaneous load (e.g. hundreds of people hitting the database at the
  // same instant), since MySQL's own default ceiling (max_connections,
  // typically 151 out of the box) sits far above this either way. If you
  // ever raise this further, check `SHOW VARIABLES LIKE 'max_connections';`
  // in MySQL Workbench first, so this app's pool plus anything else
  // connecting to the same MySQL instance (Workbench itself, other tools,
  // a second app) never adds up to more than what MySQL itself allows.
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 25,
  // Ordinary traffic doesn't need all 25 open at once — maxIdle/idleTimeout
  // let the pool burst up to connectionLimit under real load, then close
  // anything beyond this baseline after a minute of not being used, rather
  // than permanently holding 25 connections open around the clock.
  maxIdle: 10,
  idleTimeout: 60000,
  queueLimit: 0,
  decimalNumbers: true
});

module.exports = pool;
