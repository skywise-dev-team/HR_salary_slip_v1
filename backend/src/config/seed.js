/**
 * Creates the default Admin login. Run with: npm run seed
 * Creates user_id "admin" / password "Admin@123"
 */
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function seed() {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE role_name = 'Admin' LIMIT 1");
  if (!role) {
    console.error('Admin role not found. Run "npm run migrate" first.');
    process.exit(1);
  }

  const [[existing]] = await pool.query('SELECT id FROM users WHERE user_id = ?', ['admin']);
  if (existing) {
    console.log('Admin user already exists. Nothing to do.');
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash('Admin@123', 10);
  await pool.query(
    `INSERT INTO users (user_id, password_hash, email, role_id, status)
     VALUES (?, ?, ?, ?, 'ACTIVE')`,
    ['admin', passwordHash, null, role.id]
  );

  console.log('Default admin user created: user_id="admin", password="Admin@123"');
  console.log('Please change this password after first login.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
