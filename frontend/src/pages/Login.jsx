import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { MODULE_ROUTES } from '../config/modules.js';
import PasswordInput from '../components/PasswordInput.jsx';

export default function Login() {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accountChoice, setAccountChoice] = useState(null); // set when the same ID has both a staff and an employee account
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const finishLogin = (loggedInUser) => {
    if (loggedInUser.mustChangePassword) {
      navigate('/change-password');
      return;
    }
    const allowed = loggedInUser.allowedModules || [];
    // A link from an approval email (or anything similar) can ask to land
    // somewhere specific after signing in — e.g. straight on the
    // Approvals inbox — but only ever redirects there if this account
    // actually has access to that module; otherwise falls back to their
    // normal first-allowed page, same as a plain login always has.
    const redirect = searchParams.get('redirect');
    if (redirect && loggedInUser.role === 'Admin') {
      navigate(redirect);
      return;
    }
    const firstModule = Object.keys(MODULE_ROUTES).find((key) => allowed.includes(key));
    navigate(firstModule ? MODULE_ROUTES[firstModule] : '/change-password');
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await login(userId, password);
      if (result.needsAccountType) {
        // This ID belongs to both a staff account and an employee account —
        // hold onto the password (never re-typed) and ask which one they mean.
        setAccountChoice({ message: result.message });
        return;
      }
      finishLogin(result);
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const chooseAccount = async (accountType) => {
    setError('');
    setBusy(true);
    try {
      const result = await login(userId, password, accountType);
      finishLogin(result);
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed');
      setAccountChoice(null);
    } finally {
      setBusy(false);
    }
  };

  if (accountChoice) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h2>Salary Slip Register</h2>
          <p className="muted">{accountChoice.message}</p>

          {error && <div className="alert alert-error">{error}</div>}

          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => chooseAccount('staff')} style={{ marginBottom: 10 }}>
            Log in as Staff
          </button>
          <button className="btn btn-outline btn-block" disabled={busy} onClick={() => chooseAccount('employee')}>
            Log in as Employee
          </button>
          <button type="button" className="link-btn" style={{ marginTop: 14 }} onClick={() => setAccountChoice(null)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h2>Salary Slip Register</h2>
        <p className="muted">Sign in to continue</p>

        {error && <div className="alert alert-error">{error}</div>}

        <label>User ID</label>
        <input value={userId} onChange={(e) => setUserId(e.target.value)} required autoFocus />

        <label>Password</label>
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required />

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
