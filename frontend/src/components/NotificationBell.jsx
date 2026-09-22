import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function NotificationBell() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState(null); // null = not yet loaded
  const [coords, setCoords] = useState(null);
  const wrapperRef = useRef(null);
  const btnRef = useRef(null);

  const loadCount = () => {
    api.get('/api/notifications/unread-count').then(({ data }) => setCount(data.count)).catch((err) => console.error('Failed to load notification count:', err.response?.status, err.response?.data));
  };

  // Live-polls the same way the session-validity check does — so an Admin
  // who's already been sitting in the app for a while still sees a new
  // request appear without needing to log out and back in, or refresh.
  useEffect(() => {
    loadCount();
    const interval = setInterval(loadCount, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleOpen = () => {
    const next = !open;
    // Rendered with position: fixed and its coordinates computed here, from
    // the button's actual on-screen position — not positioned relative to
    // its parent. The bell lives inside the sidebar, which is much narrower
    // than the dropdown itself; anchoring it any other way risks the
    // dropdown being clipped or squeezed by the sidebar's own boundary.
    if (next && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const width = 320;
      const left = Math.min(rect.left, window.innerWidth - width - 12);
      setCoords({ top: rect.bottom + 8, left: Math.max(12, left), width });
      api.get('/api/notifications').then(({ data }) => setItems(data)).catch((err) => {
        console.error('Failed to load notifications:', err.response?.status, err.response?.data);
        setItems([]);
      });
    }
    setOpen(next);
  };

  const openNotification = async (n) => {
    if (!n.is_read) {
      await api.post(`/api/notifications/${n.id}/read`).catch(() => {});
      loadCount();
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: 1 } : x)));
    }
    if (n.approval_id && isAdmin) {
      setOpen(false);
      navigate('/approvals');
    }
  };

  const markAllRead = async () => {
    await api.post('/api/notifications/read-all').catch(() => {});
    setCount(0);
    setItems((prev) => prev?.map((x) => ({ ...x, is_read: 1 })));
  };

  return (
    <div className="notification-bell" ref={wrapperRef}>
      <button ref={btnRef} className="notification-bell-btn" onClick={toggleOpen} aria-label="Notifications">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {count > 0 && <span className="notification-badge">{count > 9 ? '9+' : count}</span>}
      </button>

      {open && coords && (
        <div className="notification-dropdown" style={{ top: coords.top, left: coords.left, width: coords.width }}>
          <div className="notification-dropdown-header">
            <strong>Notifications</strong>
            {count > 0 && <button className="link-btn" onClick={markAllRead}>Mark all read</button>}
          </div>
          <div className="notification-dropdown-list">
            {items === null && <div className="muted" style={{ padding: 12 }}>Loading...</div>}
            {items && !items.length && <div className="muted" style={{ padding: 12 }}>No notifications yet.</div>}
            {items && items.map((n) => (
              <div
                key={n.id}
                className={`notification-item${n.is_read ? '' : ' unread'}`}
                onClick={() => openNotification(n)}
              >
                <div>{n.message}</div>
                <div className="muted small">{new Date(n.created_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
