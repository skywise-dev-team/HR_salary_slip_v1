import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const name = user?.fullName ? `${user.fullName} (${user.userId})` : user?.userId;

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Account menu">
        <span className="user-menu-name">{name}</span>
        <span className="user-menu-avatar">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="user-menu-dropdown">
          <button onClick={() => { setOpen(false); navigate('/change-password'); }}>Change Password</button>
          <button onClick={() => { setOpen(false); logout(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}
