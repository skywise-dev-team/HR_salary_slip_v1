import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { Toggle, StatusBadge } from '../components/Toggle.jsx';
import SearchAutocomplete from '../components/SearchAutocomplete.jsx';
import Pagination from '../components/Pagination.jsx';
import ApproverPicker from '../components/ApproverPicker.jsx';
import EstablishmentPicker from '../components/EstablishmentPicker.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useImportSlot } from '../context/ImportContext.jsx';
import { streamImport } from '../utils/importProgress.js';
import { showResultToast } from '../utils/approvalToast.js';
import { API_BASE } from '../config/apiBase.js';

const EMPTY = { user_id: '', password: '', email: '', role_id: '', can_approve: false, all_establishments: false, establishment_ids: [] };
const PAGE_SIZE_OPTIONS = [50, 100, 150, 200];

export default function Users() {
  const [rows, setRows] = useState([]);
  const [roles, setRoles] = useState([]);
  // The Employee role is automatic for Employee Master logins - never assigned to a user.
  const assignableRoles = roles.filter((r) => r.role_name !== 'Employee');
  const [establishments, setEstablishments] = useState([]);
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
  const [roleFilter, setRoleFilter] = useState([]);
  const [estFilter, setEstFilter] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkRoleId, setBulkRoleId] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  const load = () => api.get('/api/users').then(({ data }) => setRows(data));
  useEffect(() => {
    load();
    api.get('/api/roles').then(({ data }) => setRoles(data));
    api.get('/api/establishments').then(({ data }) => setEstablishments(data)).catch(() => setEstablishments([]));
  }, []);

  // How a user's establishment access reads in the list and the details window.
  const accessLabel = (row) => {
    const names = establishments.filter((e) => (row.establishment_ids || []).includes(e.id)).map((e) => e.name);
    if (row.role_name === 'Admin') return (row.all_establishments || !names.length) ? 'All (Admin)' : (names.length <= 2 ? names.join(', ') : `${names.length} establishments`);
    if (row.all_establishments) return 'All establishments';
    if (!names.length) return 'None';
    return names.length <= 2 ? names.join(', ') : `${names.length} establishments`;
  };
  const accessTitle = (row) => (row.all_establishments || (row.role_name === 'Admin' && !(row.establishment_ids || []).length)
    ? 'All establishments'
    : establishments.filter((e) => (row.establishment_ids || []).includes(e.id)).map((e) => e.name).join(', '));
  useEffect(() => { setPage(1); }, [search, roleFilter, estFilter]);

  const openAdd = () => { setEditing(null); setForm(EMPTY); setError(''); setModalOpen(true); };
  const openEdit = (row) => { setEditing(row); setForm({ ...row, password: '', all_establishments: !!row.all_establishments, establishment_ids: row.establishment_ids || [] }); setError(''); setModalOpen(true); };

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
    const base = API_BASE;
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

  const hasAllAccess = (r) => !!r.all_establishments || (r.role_name === 'Admin' && !(r.establishment_ids || []).length);
  const filteredRows = rows.filter((r) => {
    const needle = search.trim().toLowerCase();
    if (needle && !(r.user_id.toLowerCase().includes(needle) || (r.email || '').toLowerCase().includes(needle))) return false;
    if (roleFilter.length && !roleFilter.includes(r.role_id)) return false;
    if (estFilter.length && !(hasAllAccess(r) || (r.establishment_ids || []).some((id) => estFilter.includes(id)))) return false;
    return true;
  });

  const toggleOne = (id) => setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const allSelected = filteredRows.length > 0 && filteredRows.every((r) => selectedIds.includes(r.id));
  const toggleAll = () => setSelectedIds((ids) => {
    const shown = filteredRows.map((r) => r.id);
    return allSelected ? ids.filter((id) => !shown.includes(id)) : [...new Set([...ids, ...shown])];
  });
  const pagedRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

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
        <div style={{ minWidth: 220 }}>
          <ApproverPicker
            floating
            options={roles.map((r) => ({ id: r.id, label: r.role_name }))}
            value={roleFilter}
            onChange={setRoleFilter}
            placeholder="All roles"
            searchPlaceholder="Search role"
            noun="roles"
            emptyText="No roles found."
          />
        </div>
        <div style={{ minWidth: 260 }}>
          <ApproverPicker
            floating
            options={establishments.map((e) => ({ id: e.id, label: e.name }))}
            value={estFilter}
            onChange={setEstFilter}
            placeholder="All establishments"
            searchPlaceholder="Search establishment"
            noun="establishments"
            emptyText="No establishments found."
          />
        </div>
        {(roleFilter.length > 0 || estFilter.length > 0) && (
          <button className="link-btn" onClick={() => { setRoleFilter([]); setEstFilter([]); }}>Clear filters</button>
        )}
      </div>

      {selectedIds.length > 0 && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{selectedIds.length} selected</strong>
          <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => bulkSetStatus('ACTIVE')}>Activate</button>
          <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => bulkSetStatus('INACTIVE')}>Deactivate</button>
          <select value={bulkRoleId} onChange={(e) => setBulkRoleId(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="">Set role to...</option>
            {assignableRoles.map((r) => <option key={r.id} value={r.id}>{r.role_name}</option>)}
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
              <th>User ID</th><th>Email</th><th>Role</th><th>Establishments</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={selectedIds.includes(r.id)} onChange={() => toggleOne(r.id)} /></td>
                <td>{r.user_id}</td>
                <td>{r.email || '-'}</td>
                <td>{r.role_name}</td>
                <td title={accessTitle(r)}>{accessLabel(r)}</td>
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
            {!filteredRows.length && <tr><td colSpan={7} className="muted">{(search || roleFilter.length || estFilter.length) ? 'No matching users.' : 'No users yet.'}</td></tr>}
          </tbody>
        </table>
        <Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalItems={filteredRows.length} pageSizeOptions={PAGE_SIZE_OPTIONS} />
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
            </div>
            <div>
              <label>{editing ? 'New password (optional)' : 'Password'}</label>
              <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!editing} />
            </div>

            <div>
              <label>Email</label>
              <input type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="span-2">
              <label>Role</label>
              <select value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })} required>
                <option value="">Select role</option>
                {assignableRoles.map((r) => <option key={r.id} value={r.id}>{r.role_name}</option>)}
              </select>
            </div>

            {form.role_id && (
              <div className="span-2">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={editing?.user_id === 'admin' ? true : !!form.can_approve}
                    disabled={editing?.user_id === 'admin'}
                    style={{ width: 16, height: 16, flex: '0 0 16px' }}
                    onChange={(e) => setForm({ ...form, can_approve: e.target.checked })}
                  />
                  Can approve (can be chosen as an approver in Approval Routing, for the establishments this user has access to)
                </label>
              </div>
            )}

            {(() => {
              const isAdminRole = roles.find((r) => String(r.id) === String(form.role_id))?.role_name === 'Admin';
              return (
              <div className="span-2">
                <label>{isAdminRole ? 'Establishments for approval requests' : 'Establishment access'}</label>
                <EstablishmentPicker
                  options={establishments}
                  value={{ all: !!form.all_establishments || (isAdminRole && !(form.establishment_ids || []).length), ids: form.establishment_ids || [] }}
                  onChange={(v) => setForm({ ...form, all_establishments: v.all, establishment_ids: v.ids })}
                />
              </div>
              );
            })()}

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
            <div><span>Establishments</span><span>{accessTitle(viewing) || 'None'}</span></div>
            <div><span>Status</span><span><StatusBadge status={viewing.status} /></span></div>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
