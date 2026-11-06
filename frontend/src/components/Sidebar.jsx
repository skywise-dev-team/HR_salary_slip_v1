import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import NotificationBell from './NotificationBell.jsx';
import UserMenu from './UserMenu.jsx';
import api from '../api/axios.js';

const ICONS = {
  '/dashboard': <><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></>,
  '/establishments': <><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-6h6v6" /></>,
  '/employees': <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><path d="M18 14.5c2.2.7 3.5 2.7 3.5 5.5" /></>,
  '/upload-salary': <><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 20h16" /></>,
  '/salary-slips': <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h7M9 17h7" /></>,
  '/change-password': <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  '/users': <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" /></>,
  '/roles': <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  '/activity-log': <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  '/approvals': <><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></>,
  '/approval-routing': <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5V12a4 4 0 0 0 4 4h5.5" /></>
};

export default function Sidebar() {
  const { canView, canApprove } = useAuth();
  const [open, setOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Same 15-second live-poll pattern as the notification bell and the
  // session-validity check — an Admin sitting in the app already sees the
  // count update on its own, without needing to visit the page or refresh.
  useEffect(() => {
    if (!canApprove) return;
    const load = () => api.get('/api/approvals/count')
      .then(({ data }) => setPendingCount(data.count))
      .catch((err) => console.error('Failed to load approvals count:', err.response?.status, err.response?.data));
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [canApprove]);

  const item = (to, label, badge) => (
    <NavLink to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={() => setOpen(false)}>
      <svg className="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICONS[to]}</svg>
      <span className="nav-label">{label}</span>
      {badge > 0 && <span className="nav-item-badge">{badge > 9 ? '9+' : badge}</span>}
    </NavLink>
  );

  const showMaster = canView('establishments') || canView('employees');
  const showAdmin = canView('users') || canView('roles_permissions') || canView('activity_log') || canView('approval_routing') || canApprove;

  return (
    <div className="sidebar-slot">
      <div className="mobile-topbar">
        <button className="hamburger-btn" onClick={() => setOpen(true)} aria-label="Open menu">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="mobile-topbar-title">Salary Slip Register</div>
        <NotificationBell />
        <UserMenu />
      </div>

      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}

      <aside className={`sidebar${open ? ' sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-mark">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 2.5h14v19l-2.33-1.6L14.33 21.5 12 19.9l-2.33 1.6L7.33 19.9 5 21.5z" />
              <path d="M8.5 7h7M8.5 10h7M10 7c2.6 0 2.6 3 0 3l3.5 4.2" />
              <path d="M8.5 16.5h3" />
            </svg>
          </div>
          <div className="brand-title">Salary Slip Register</div>
          <div className="brand-bell"><NotificationBell /></div>
        </div>

        <nav className="nav-scroll">
          {canView('dashboard') && item('/dashboard', 'Dashboard')}

          {showMaster && <div className="nav-group-label">MASTER</div>}
          {canView('establishments') && item('/establishments', 'Establishments')}
          {canView('employees') && item('/employees', 'Employee Master')}

          {canView('upload_salary') && item('/upload-salary', 'Upload Salary Data')}
          {canView('salary_slips') && item('/salary-slips', 'Salary Slips')}

          {showAdmin && (
            <>
              <div className="nav-group-label">ADMIN</div>
              {canView('users') && item('/users', 'Users')}
              {canView('roles_permissions') && item('/roles', 'Roles & Permissions')}
              {canView('activity_log') && item('/activity-log', 'Activity Log')}
              {canApprove && item('/approvals', 'Approvals', pendingCount)}
              {canView('approval_routing') && item('/approval-routing', 'Approval Routing')}
            </>
          )}
        </nav>

      </aside>
    </div>
  );
}
