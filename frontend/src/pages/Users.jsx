import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { Toggle, StatusBadge } from '../components/Toggle.jsx';
import SearchAutocomplete from '../components/SearchAutocomplete.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useImportSlot } from '../context/ImportContext.jsx';
import { streamImport } from '../utils/importProgress.js';
import { showResultToast } from '../utils/approvalToast.js';

const EMPTY = { user_id: '', password: '', email: '', role_id: '', can_approve: false };

export default function Users() {
  const [rows, setRows] = useState([]);
  const [roles, setRoles] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState('');
  const [importFile, setImportFile] = useState(null);
  const { importing, progress: importProgress, result: importResult, startImport, updateProgress, finishImport, cancelImport } = useImportSlot('users');
  const { showToast } = useToast();
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkRoleId, setBulkRoleId] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = () => api.get('/api/users').then(({ data }) => setRows(data));
  useEffect(() => { load(); api.get('/api/roles').then(({ data }) => setRoles(data)); }, []);

  const openAdd = () => { setEditing(null); setForm(EMPTY); setError(''); setModalOpen(true); };
  const openEdit = (row) => { setEditing(row); setForm({ ...row, password: '' }); setError(''); setModalOpen(true); };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      let res;
      if (editing) res = await api.put(`/api/users/${editing.id}`, form);
      else res = await api.post('/api/users', form);
      setModalOpen(false);
      showResultToast(showToast, res, editing ? 'User updated successfully!' : 'User added successfully!');
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    }
  };

  const toggleStatus = async (row) => {
    const next = row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    if (!confirm(`${next === 'ACTIVE' ? 'Activate' : 'Deactivate'} user "${row.user_id}"?`)) return;
    try {
      const res = await api.patch(`/api/users/${row.id}/status`, { status: next });
      showResultToast(showToast, res, `User ${next === 'ACTIVE' ? 'activated' : 'deactivated'}.`);
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not update status', 'error');
    }
  };

  const remove = async (row) => {
    if (!confirm(`Delete user "${row.user_id}"?`)) return;
    try {
      const res = await api.delete(`/api/users/${row.id}`);
      showResultToast(showToast, res, 'User deleted.');
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not delete user', 'error');
    }
  };

  const resetPassword = async (row) => {
    if (!confirm(`Reset the password for "${row.user_id}" back to their User ID? They will be required to set a new password at next sign-in.`)) return;
    try {
      const { data } = await api.post(`/api/users/${row.id}/reset-password`);
      showToast(data.message || 'Password reset successfully!');
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not reset password', 'error');
    }
  };

  const downloadTemplate = () => {
    const token = localStorage.getItem('token');
    const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
    window.open(`${base}/api/users/template?token=${token}`, '_blank');
  };

  const runImport = async () => {
    if (!importFile) return;
    const controller = new AbortController();
    startImport(controller);
    const fd = new FormData();
    fd.append('file', importFile);
    let finalResult = null;
    let midStreamError = null;
    try {
      const { status } = await streamImport(api, '/api/users/import', fd, {
        signal: controller.signal,
        onEvent: (evt) => {
          if (evt.type === 'total' || evt.type === 'progress') {
            updateProgress({ processed: evt.processed || 0, total: evt.total, percent: evt.percent || 0 });
          } else if (evt.type === 'done') {
            const { type, ...rest } = evt;
            finalResult = rest;
          } else if (evt.type === 'error') {
            midStreamError = evt.message;
          }
        }
      });
      if (status === 202) {
        finishImport(null);
        showToast('Submitted for approval, pending.', 'info');
      } else if (midStreamError) {
        finishImport({ errors: [midStreamError] });
      } else {
        finishImport(finalResult);
        if (finalResult) {
          showToast(`${finalResult.inserted || 0} new user(s), ${finalResult.updated || 0} updated.`);
          load();
        }
      }
    } catch (err) {
      if (err.code === 'ERR_CANCELED') {
        finishImport(null);
        showToast('Import cancelled — nothing was saved.', 'info');
      } else {
        finishImport({ errors: [err.response?.data?.message || 'Import failed — check your connection and try again.'] });
      }
    }
  };

  const filteredRows = search.trim()
    ? rows.filter((r) => {
        const needle = search.trim().toLowerCase();
        return r.user_id.toLowerCase().includes(needle) || (r.email || '').toLowerCase().includes(needle);
      })
    : rows;

  const toggleOne = (id) => setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const allSelected = filteredRows.length > 0 && filteredRows.every((r) => selectedIds.includes(r.id));
  const toggleAll = () => setSelectedIds(allSelected ? [] : filteredRows.map((r) => r.id));

  const bulkSetStatus = async (status) => {
    if (!selectedIds.length) return;
    if (!confirm(`${status === 'ACTIVE' ? 'Activate' : 'Deactivate'} ${selectedIds.length} selected user(s)?`)) return;
    setBulkBusy(true);
    try {
      const res = await api.patch('/api/users/bulk/status', { ids: selectedIds, status });
      showResultToast(showToast, res, 'Updated successfully!');
      setSelectedIds([]);
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Bulk update failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkSetRole = async () => {
    if (!selectedIds.length || !bulkRoleId) return;
    const roleName = roles.find((r) => String(r.id) === String(bulkRoleId))?.role_name || 'the selected role';
    if (!confirm(`Set ${selectedIds.length} selected user(s) to role "${roleName}"?`)) return;
    setBulkBusy(true);
    try {
      const res = await api.patch('/api/users/bulk/role', { ids: selectedIds, role_id: bulkRoleId });
      showResultToast(showToast, res, 'Updated successfully!');
      setSelectedIds([]);
      setBulkRoleId('');
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Bulk update failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    if (!selectedIds.length) return;
    if (!confirm(`Delete ${selectedIds.length} selected user(s)? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const res = await api.delete('/api/users/bulk', { data: { ids: selectedIds } });
      showResultToast(showToast, res, 'Deleted successfully!');
      setSelectedIds([]);
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Bulk delete failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Users</h1>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>Add user</button>
      </div>

      <div className="card">
        <h3>Bulk import from Excel</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline" onClick={downloadTemplate}>Download template</button>
          <input type="file" accept=".xlsx" onChange={(e) => setImportFile(e.target.files[0])} />
          <button className="btn btn-primary" onClick={runImport} disabled={!importFile || importing}>
            {importing ? 'Importing...' : 'Import from Excel'}
          </button>
          {importing && (
            <button type="button" className="btn btn-outline btn-danger-outline" onClick={cancelImport}>Cancel</button>
          )}
        </div>
        {importing && importProgress && (
          <div className="import-progress">
            <div className="import-progress-track">
              <div className="import-progress-fill" style={{ width: `${importProgress.percent}%` }} />
            </div>
            <span className="import-progress-label">
              {importProgress.percent}% ({importProgress.processed}/{importProgress.total} rows)
            </span>
          </div>
        )}
        {importResult && (
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            Inserted: {importResult.inserted || 0}, updated: {importResult.updated || 0}, skipped: {importResult.skipped || 0}
            {importResult.errors?.length > 0 && (
              <ul>{importResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            )}
          </div>
        )}
      </div>

      <div className="filter-bar">
        <SearchAutocomplete
          placeholder="User ID or email"
          value={search}
          onChange={setSearch}
          options={rows}
          getLabel={(r) => `${r.user_id}${r.email ? ' (' + r.email + ')' : ''}`}
          getValue={(r) => r.user_id}
          getKey={(r) => r.id}
        />
      </div>

      {selectedIds.length > 0 && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{selectedIds.length} selected</strong>
          <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => bulkSetStatus('ACTIVE')}>Activate</button>
          <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => bulkSetStatus('INACTIVE')}>Deactivate</button>
          <select value={bulkRoleId} onChange={(e) => setBulkRoleId(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="">Set role to...</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.role_name}</option>)}
          </select>
          <button className="btn btn-outline btn-sm" disabled={bulkBusy || !bulkRoleId} onClick={bulkSetRole}>Apply role</button>
          <button className="btn btn-outline btn-sm btn-danger-outline" disabled={bulkBusy} onClick={bulkDelete}>Delete selected</button>
          <button className="link-btn" onClick={() => setSelectedIds([])}>Clear selection</button>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 32 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
              <th>User ID</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={selectedIds.includes(r.id)} onChange={() => toggleOne(r.id)} /></td>
                <td>{r.user_id}</td>
                <td>{r.email || '-'}</td>
                <td>{r.role_name}</td>
                <td>
                  <div className="toggle-cell">
                    <Toggle checked={r.status === 'ACTIVE'} onChange={() => toggleStatus(r)} />
                    <StatusBadge status={r.status} />
                  </div>
                </td>
                <td>
                  <button className="link-btn" onClick={() => openEdit(r)}>Edit</button>
                  <button className="link-btn" onClick={() => setViewing(r)}>View</button>
                  {isAdmin && <button className="link-btn" onClick={() => resetPassword(r)}>Reset Password</button>}
                  <button className="link-btn danger" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
            {!filteredRows.length && <tr><td colSpan={6} className="muted">{search ? 'No matching users.' : 'No users yet.'}</td></tr>}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <Modal title={editing ? 'Edit user' : 'Add user'} onClose={() => setModalOpen(false)}>
          <form onSubmit={submit} className="form-grid">
            {error && <div className="alert alert-error span-2">{error}</div>}

            <div>
              <label>User ID</label>
              <input
                value={form.user_id}
                onChange={(e) => setForm({ ...form, user_id: e.target.value })}
                pattern="[a-zA-Z0-9]+"
                required
                disabled={!!editing}
              />
              <small className="hint">Letters and numbers only.</small>
            </div>
            <div>
              <label>{editing ? 'New password (optional)' : 'Password'}</label>
              <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!editing} />
            </div>

            <div>
              <label>Email</label>
              <input type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="span-2">
              <label>Role</label>
              <select value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })} required>
                <option value="">Select role</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.role_name}</option>)}
              </select>
            </div>

            {roles.find((r) => String(r.id) === String(form.role_id))?.role_name === 'Admin' && (
              <div className="span-2">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={editing?.user_id === 'admin' ? true : !!form.can_approve}
                    disabled={editing?.user_id === 'admin'}
                    onChange={(e) => setForm({ ...form, can_approve: e.target.checked })}
                  />
                  Can approve (eligible to be assigned specific approval tasks)
                </label>
              </div>
            )}

            <div className="span-2 modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="btn btn-primary">{editing ? 'Save changes' : 'Add user'}</button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && (
        <Modal title={`User — ${viewing.user_id}`} onClose={() => setViewing(null)}>
          <div className="detail-list">
            <div><span>User ID</span><span>{viewing.user_id}</span></div>
            <div><span>Email</span><span>{viewing.email || '-'}</span></div>
            <div><span>Role</span><span>{viewing.role_name}</span></div>
            <div><span>Status</span><span><StatusBadge status={viewing.status} /></span></div>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
