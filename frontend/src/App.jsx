import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { useAuth } from './context/AuthContext.jsx';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Establishments from './pages/Establishments.jsx';
import EmployeeMaster from './pages/EmployeeMaster.jsx';
import UploadSalaryData from './pages/UploadSalaryData.jsx';
import SalarySlips from './pages/SalarySlips.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import Users from './pages/Users.jsx';
import RolesPermissions from './pages/RolesPermissions.jsx';
import ActivityLog from './pages/ActivityLog.jsx';
import Approvals from './pages/Approvals.jsx';
import ApprovalRouting from './pages/ApprovalRouting.jsx';

function ModuleRoute({ moduleKey, children }) {
  const { canView, firstAllowedPath } = useAuth();
  return canView(moduleKey) ? children : <Navigate to={firstAllowedPath()} replace />;
}

// Approvals is deliberately NOT a togglable module in Roles & Permissions —
// only the Admin role can ever reach it, with no way to accidentally grant
// this to anyone else the way a normal module permission could be.
function AdminRoute({ children }) {
  const { isAdmin, firstAllowedPath } = useAuth();
  return isAdmin ? children : <Navigate to={firstAllowedPath()} replace />;
}

// Stricter still: only the one protected admin account may configure
// approval routing rules — if any Admin could, they could trivially
// reassign a restricted rule to include themselves.
function SuperAdminRoute({ children }) {
  const { isSuperAdmin, firstAllowedPath } = useAuth();
  return isSuperAdmin ? children : <Navigate to={firstAllowedPath()} replace />;
}

function HomeRedirect() {
  const { firstAllowedPath } = useAuth();
  return <Navigate to={firstAllowedPath()} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route path="/dashboard" element={<ProtectedRoute><ModuleRoute moduleKey="dashboard"><Dashboard /></ModuleRoute></ProtectedRoute>} />
      <Route path="/establishments" element={<ProtectedRoute><ModuleRoute moduleKey="establishments"><Establishments /></ModuleRoute></ProtectedRoute>} />
      <Route path="/employees" element={<ProtectedRoute><ModuleRoute moduleKey="employees"><EmployeeMaster /></ModuleRoute></ProtectedRoute>} />
      <Route path="/upload-salary" element={<ProtectedRoute><ModuleRoute moduleKey="upload_salary"><UploadSalaryData /></ModuleRoute></ProtectedRoute>} />
      <Route path="/salary-slips" element={<ProtectedRoute><ModuleRoute moduleKey="salary_slips"><SalarySlips /></ModuleRoute></ProtectedRoute>} />

      {/* Change Password is account-level, not tied to a module permission */}
      <Route path="/change-password" element={<ProtectedRoute><ChangePassword /></ProtectedRoute>} />

      <Route path="/users" element={<ProtectedRoute><ModuleRoute moduleKey="users"><Users /></ModuleRoute></ProtectedRoute>} />
      <Route path="/roles" element={<ProtectedRoute><ModuleRoute moduleKey="roles_permissions"><RolesPermissions /></ModuleRoute></ProtectedRoute>} />
      <Route path="/activity-log" element={<ProtectedRoute><ModuleRoute moduleKey="activity_log"><ActivityLog /></ModuleRoute></ProtectedRoute>} />
      <Route path="/approvals" element={<ProtectedRoute><AdminRoute><Approvals /></AdminRoute></ProtectedRoute>} />
      <Route path="/approval-routing" element={<ProtectedRoute><SuperAdminRoute><ApprovalRouting /></SuperAdminRoute></ProtectedRoute>} />

      <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
      <Route path="*" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
    </Routes>
  );
}
