import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from '../api/axios.js';
import { MODULE_ROUTES } from '../config/modules.js';
import { isTaskActive } from '../utils/activeTaskTracker.js';

const AuthContext = createContext(null);

// Reads the `exp` claim (seconds since epoch) out of a JWT without needing
// the secret — the payload is just base64url-encoded, not encrypted. Used
// to schedule a mandatory logout at the exact moment the session actually
// expires, rather than only reacting after some future API call happens to
// fail with 401 — someone who's just sitting on a page, making no requests
// at all, should still be logged out right on time.
function getTokenExpiryMs(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user');
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(true);

  // Re-fetches the current user's role/permissions from the server. Pages
  // that depend on up-to-date access (e.g. Salary Slips) call this on
  // mount so an admin's change takes effect without requiring a full
  // logout/login — the JWT session itself can stay open for hours.
  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get('/api/auth/me');
      setUser(data.user);
      localStorage.setItem('user', JSON.stringify(data.user));
      return data.user;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    refreshUser().finally(() => setLoading(false));
  }, [refreshUser]);

  const login = async (userId, password, accountType) => {
    const { data } = await api.post('/api/auth/login', { userId, password, accountType });
    if (data.needsAccountType) {
      // Not a completed login — this ID belongs to both a staff account and
      // an employee account, and the server needs to know which one is
      // meant before it can proceed. The caller (Login.jsx) shows a choice
      // and calls login() again with that choice as accountType.
      return { needsAccountType: true, message: data.message };
    }
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  // Mandatory session timeout — every login (staff account or Employee
  // Master login alike) is force-logged-out once its token's real
  // expiration is reached, whether or not anything on screen ever triggers
  // another API call before then. Re-armed whenever `user` changes (login,
  // or a page's refreshUser() call), always against the token's actual
  // `exp`, so this can never drift from what the server considers expired.
  // The one exception: a long-running task (currently, a bulk Excel
  // import) that's still in progress when the timer would otherwise fire —
  // logging someone out mid-task would abandon it from their point of view
  // even if it technically finishes on the server, so this checks again
  // shortly instead of logging out immediately, and keeps re-checking
  // until the task is actually done.
  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    const expiryMs = getTokenExpiryMs(token);
    if (!expiryMs) return;

    let timer;
    const attemptLogout = () => {
      if (isTaskActive()) {
        timer = setTimeout(attemptLogout, 10000);
        return;
      }
      logout();
    };

    const msRemaining = expiryMs - Date.now();
    if (msRemaining <= 0) {
      attemptLogout();
    } else {
      timer = setTimeout(attemptLogout, msRemaining);
    }
    return () => clearTimeout(timer);
  }, [user]);

  // Immediate logout on an admin-side access change — e.g. an employee's
  // status or App Access is flipped off, a staff account is deactivated, or
  // someone's role/permissions change — while that person is already
  // signed in and simply sitting on a page, making no requests of their
  // own. requireAuth already re-checks status/app_access fresh from the
  // database on every single request; the only real gap was that nothing
  // was actually asking again until the person's next click. This
  // periodically repeats the exact same /api/auth/me check refreshUser
  // already performs elsewhere — if the server ever rejects it, the axios
  // response interceptor (api/axios.js) immediately clears the session and
  // redirects to /login on its own, so no extra handling is needed here
  // beyond just asking again regularly. Skipped entirely while a task
  // (bulk import) is active — this check has no way to "defer" the way the
  // timeout above does, since an actual rejection here is acted on
  // immediately by the interceptor, so the safest thing during a task is
  // to simply not ask at all until it's finished.
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      if (isTaskActive()) return;
      refreshUser();
    }, 15000);
    return () => clearInterval(interval);
  }, [user, refreshUser]);

  const isAdmin = user?.role === 'Admin';
  const isSuperAdmin = user?.userId === 'admin';
  const allowedModules = user?.allowedModules || [];
  const permissions = user?.permissions || {};
  const canView = (moduleKey) => allowedModules.includes(moduleKey);
  const can = (moduleKey, action = 'view') => !!permissions[moduleKey]?.[action];

  // Where to land a user who has no permission for the page they tried to open.
  const firstAllowedPath = () => {
    const firstModule = Object.keys(MODULE_ROUTES).find((key) => allowedModules.includes(key));
    return firstModule ? MODULE_ROUTES[firstModule] : '/change-password';
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, loading, isAdmin, isSuperAdmin, allowedModules, permissions, canView, can, firstAllowedPath, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
