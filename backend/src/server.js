require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const establishmentRoutes = require('./routes/establishments');
const employeeRoutes = require('./routes/employees');
const salaryDataRoutes = require('./routes/salaryData');
const salarySlipRoutes = require('./routes/salarySlips');
const userRoutes = require('./routes/users');
const roleRoutes = require('./routes/roles');
const dashboardRoutes = require('./routes/dashboard');
const activityLogRoutes = require('./routes/activityLog');
const approvalsRoutes = require('./routes/approvals');
const approvalRoutingRoutes = require('./routes/approvalRouting');
const notificationsRoutes = require('./routes/notifications');
const { MAX_LOGO_SIGNATURE_SIZE } = require('./middleware/upload');
const cron = require('node-cron');
const { runRetentionCleanup } = require('./utils/retentionCleanup');
const { expireStaleApprovalRequests } = require('./utils/approvals');

const app = express();

app.use(cors({ origin: (process.env.CORS_ORIGIN || '*').split(',') }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/establishments', establishmentRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/salary-data', salaryDataRoutes);
app.use('/api/salary-slips', salarySlipRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/activity-log', activityLogRoutes);
app.use('/api/approvals', approvalsRoutes);
app.use('/api/approval-routing', approvalRoutingRoutes);
app.use('/api/notifications', notificationsRoutes);

// Central error handler
app.use((err, req, res, next) => {
  // Multer's own file-size-limit error, thrown by the upload middleware
  // before the route handler ever runs — give a clear message naming the
  // actual limit instead of Multer's generic "File too large".
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = Math.round(MAX_LOGO_SIGNATURE_SIZE / (1024 * 1024));
    return res.status(413).json({ message: `File is too large — the maximum allowed size is ${maxMb} MB.` });
  }
  console.error(err);
  // If a streaming response (e.g. a bulk import's progress updates) has
  // already started sending data, headers can't be changed anymore — hand
  // off to Express's built-in handler (which just ends the connection)
  // instead of crashing on "Cannot set headers after they are sent".
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Salary Slip System API running on port ${PORT}`));

// Retention cleanup — runs once a day at 2 AM server time. Removes
// activity_log entries older than 6 months. (Salary slip PDFs are never
// stored on disk at all anymore — each one is generated fresh, on demand,
// at the moment it's actually previewed or downloaded — so there's no
// slip-file cleanup left to do here.) This runs inside the same Node.js
// process rather than needing a separate OS-level scheduled task (Windows
// Task Scheduler, cron, etc.) — as long as the server process itself is
// running, this fires on schedule regardless of platform. Also runs once
// immediately on startup, so a server that's only restarted occasionally
// (rather than kept running continuously) doesn't silently skip cleanup
// for long stretches.
cron.schedule('0 2 * * *', runRetentionCleanup);
cron.schedule('0 2 * * *', expireStaleApprovalRequests);
runRetentionCleanup();
expireStaleApprovalRequests();
