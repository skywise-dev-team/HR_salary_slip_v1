import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import api from '../api/axios.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';

export default function ChangePassword() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { user, refreshUser, firstAllowedPath } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const forced = !!user?.mustChangePassword;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.newPassword !== form.confirmPassword) {
      setError('New password and confirmation do not match');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword
      });
      showToast('Password updated successfully!');
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });

      if (forced) {
        // Re-pull /me so mustChangePassword clears, then move on to
        // wherever this account is actually allowed to go.
        const freshUser = await refreshUser();
        navigate(firstAllowedPath(), { replace: true });
        void freshUser;
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout>
      <h1 className="page-title">Change password</h1>

      <div className="card" style={{ maxWidth: 420 }}>
        <form onSubmit={submit} className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          {error && <div className="alert alert-error">{error}</div>}
          {forced && <div className="alert alert-info">Your current password is the one you were given to sign in with.</div>}

          <div>
            <label>Current password</label>
            <PasswordInput value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} required />
          </div>
          <div>
            <label>New password</label>
            <PasswordInput value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} required minLength={6} />
          </div>
          <div>
            <label>Confirm new password</label>
            <PasswordInput value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} required minLength={6} />
          </div>

          <button className="btn btn-primary" disabled={busy}>{busy ? 'Updating...' : 'Update password'}</button>
        </form>
      </div>
    </Layout>
  );
}
