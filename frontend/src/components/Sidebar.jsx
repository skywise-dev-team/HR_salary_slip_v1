import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import NotificationBell from './NotificationBell.jsx';
import api from '../api/axios.js';

export default function Sidebar() {
  const { user, logout, canView, isAdmin, isSuperAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Same 15-second live-poll pattern as the notification bell and the
  // session-validity check — an Admin sitting in the app already sees the
  // count update on its own, without needing to visit the page or refresh.
  useEffect(() => {
    if (!isAdmin) return;
    const load = () => api.get('/api/approvals/count')
      .then(({ data }) => setPendingCount(data.count))
      .catch((err) => console.error('Failed to load approvals count:', err.response?.status, err.response?.data));
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [isAdmin]);

  const item = (to, label, badge) => (
    <NavLink to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setOpen(false)}>
      {label}
      {badge > 0 && <span className="nav-item-badge">{badge > 9 ? '9+' : badge}</span>}
    </NavLink>
  );

  const showMaster = canView('establishments') || canView('employees');
  const showAdmin = canView('users') || canView('roles_permissions') || canView('activity_log') || isAdmin;

  return (
    <>
      <div className="mobile-topbar">
        <button className="hamburger-btn" onClick={() => setOpen(true)} aria-label="Open menu">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="mobile-topbar-title">Salary Slip Register</div>
        <NotificationBell />
      </div>

      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}

      <aside className={`sidebar${open ? ' sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <div>
            <div className="brand-title">Salary Slip Register</div>
          </div>
          <NotificationBell />
        </div>

        <nav className="nav-scroll">
          {canView('dashboard') && item('/dashboard', 'Dashboard')}

          {showMaster && <div className="nav-group-label">MASTER</div>}
          {canView('establishments') && item('/establishments', 'Establishments')}
          {canView('employees') && item('/employees', 'Employee Master')}

          {canView('upload_salary') && item('/upload-salary', 'Upload Salary Data')}
          {canView('salary_slips') && item('/salary-slips', 'Salary Slips')}
          {item('/change-password', 'Change Password')}

          {showAdmin && (
            <>
              <div className="nav-group-label">ADMIN</div>
              {canView('users') && item('/users', 'Users')}
              {canView('roles_permissions') && item('/roles', 'Roles & Permissions')}
              {canView('activity_log') && item('/activity-log', 'Activity Log')}
              {isAdmin && item('/approvals', 'Approvals', pendingCount)}
              {isSuperAdmin && item('/approval-routing', 'Approval Routing')}
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="user-chip">
            {user?.fullName ? `${user.fullName} (${user.userId})` : user?.userId}
          </div>
          <button className="btn btn-outline btn-block" onClick={logout}>Sign out</button>
        </div>
      </aside>
    </>
  );
}
