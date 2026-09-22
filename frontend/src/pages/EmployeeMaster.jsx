import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import { Toggle, StatusBadge } from '../components/Toggle.jsx';
import SearchAutocomplete from '../components/SearchAutocomplete.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useImportSlot } from '../context/ImportContext.jsx';
import { showResultToast } from '../utils/approvalToast.js';
import { streamImport } from '../utils/importProgress.js';

const EMPTY = {
  employee_id: '', full_name: '', relative_name: '', relation: '', designation: '',
  uan: '', bank_account_no: '', establishment_id: '', active_from: '', status: 'ACTIVE',
  email: '', app_access: 'NO', salary_slip_access: 'VIEW_ONLY'
};

const SALARY_ACCESS_LABELS = {
  VIEW_DOWNLOAD: 'View & download',
  VIEW_ONLY: 'View only',
  NO_ACCESS: 'No access'
};

export default function EmployeeMaster() {
  const [rows, setRows] = useState([]);
  const [allEmployees, setAllEmployees] = useState([]); // unfiltered, for search suggestions
  const [establishments, setEstablishments] = useState([]);
  const [search, setSearch] = useState('');
  const [estFilter, setEstFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [historyFor, setHistoryFor] = useState(null);
  const [history, setHistory] = useState([]);
  const [importFile, setImportFile] = useState(null);
  const { importing, progress: importProgress, result: importResult, startImport, updateProgress, finishImport, cancelImport } = useImportSlot('employees');
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const { showToast } = useToast();
  const { isAdmin } = useAuth();

  const load = () => {
    const params = {};
    if (search) params.search = search;
    if (estFilter) params.establishment_id = estFilter;
    if (statusFilter) params.status = statusFilter;
    api.get('/api/employees', { params }).then(({ data }) => { setRows(data); setSelectedIds([]); });
  };

  useEffect(() => {
    api.get('/api/establishments').then(({ data }) => setEstablishments(data));
    api.get('/api/employees').then(({ data }) => setAllEmployees(data));
  }, []);
  useEffect(() => { load(); }, [search, estFilter, statusFilter]);

  const refreshAllEmployees = () => api.get('/api/employees').then(({ data }) => setAllEmployees(data));

  const openAdd = () => { setEditing(null); setForm(EMPTY); setError(''); setModalOpen(true); };
  const openEdit = (row) => {
    setEditing(row);
    setForm({ ...row, active_from: row.active_from ? row.active_from.slice(0, 10) : '' });
    setError('');
    setModalOpen(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        const res = await api.put(`/api/employees/${editing.id}`, form);
        showResultToast(showToast, res, 'Employee updated successfully!');
      } else {
        const res = await api.post('/api/employees', form);
        showResultToast(showToast, res, 'Employee added successfully!');
      }
      setModalOpen(false);
      load();
      refreshAllEmployees();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    }
  };

  const toggleStatus = async (row) => {
    const next = row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const accessNote = next === 'INACTIVE' ? ' This also revokes their app access.' : ' This also grants/restores their app access.';
    if (!confirm(`${next === 'ACTIVE' ? 'Reactivate' : 'Deactivate'} employee "${row.full_name}"?${accessNote}`)) return;
    const res = await api.patch(`/api/employees/${row.id}/status`, { status: next });
    showResultToast(showToast, res, `Employee ${next === 'ACTIVE' ? 'reactivated' : 'deactivated'}.`);
    load();
  };

  const remove = async (row) => {
    if (!confirm(`Delete employee "${row.full_name}"?`)) return;
    const res = await api.delete(`/api/employees/${row.id}`);
    showResultToast(showToast, res, 'Employee deleted.');
    load();
    refreshAllEmployees();
  };

  const resetPassword = async (row) => {
    if (!confirm(`Reset the password for "${row.employee_id}" back to their Employee ID? They will be required to set a new password at next sign-in.`)) return;
    try {
      const { data } = await api.post(`/api/employees/${row.id}/reset-password`);
      showToast(data.message || 'Password reset successfully!');
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not reset password', 'error');
    }
  };

  const toggleOne = (id) => setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.includes(r.id));
  const toggleAll = () => setSelectedIds(allSelected ? [] : rows.map((r) => r.id));

  const bulkSetStatus = async (status) => {
    if (!selectedIds.length) return;
    const accessNote = status === 'INACTIVE' ? ' This also revokes their app access.' : ' This also grants/restores their app access.';
    if (!confirm(`${status === 'ACTIVE' ? 'Reactivate' : 'Deactivate'} ${selectedIds.length} selected employee(s)?${accessNote}`)) return;
    setBulkBusy(true);
    try {
      const res = await api.patch('/api/employees/bulk/status', { ids: selectedIds, status });
      showResultToast(showToast, res, 'Updated successfully!');
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Bulk update failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    if (!selectedIds.length) return;
    if (!confirm(`Delete ${selectedIds.length} selected employee(s)? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const res = await api.delete('/api/employees/bulk', { data: { ids: selectedIds } });
      showResultToast(showToast, res, 'Deleted successfully!');
      load();
      refreshAllEmployees();
    } catch (err) {
      showToast(err.response?.data?.message || 'Bulk delete failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const openHistory = async (row) => {
    setHistoryFor(row);
    const { data } = await api.get(`/api/employees/${row.id}/history`);
    setHistory(data);
  };

  const downloadTemplate = () => {
    const token = localStorage.getItem('token');
    const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
    window.open(`${base}/api/employees/template?token=${token}`, '_blank');
  };

  // The one "Export to Excel" button exports full posting history (one row
  // per establishment transfer), not just a current-state snapshot — that
  // way an employee's past postings, and even employees since deleted, still
  // show up in the file.
  const exportToExcel = () => {
    const token = localStorage.getItem('token');
    const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (estFilter) params.set('establishment_id', estFilter);
    if (statusFilter) params.set('status', statusFilter);
    params.set('token', token);
    window.open(`${base}/api/employees/export-history?${params.toString()}`, '_blank');
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
      const { status } = await streamImport(api, '/api/employees/import', fd, {
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
        // Not an Admin — the file was staged for approval rather than
        // actually imported. There's no per-row summary to show yet.
        finishImport(null);
        showToast('Submitted for approval, pending.', 'info');
      } else if (midStreamError) {
        finishImport({ errors: [midStreamError] });
      } else {
        finishImport(finalResult);
        if (finalResult) {
          showToast(`${finalResult.inserted || 0} new employee(s), ${finalResult.updated || 0} updated.`);
          load();
          refreshAllEmployees();
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

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Employee master</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={exportToExcel}>Export to Excel</button>
          <button className="btn btn-primary" onClick={openAdd}>Add one employee</button>
        </div>
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
          placeholder="Name, ID or designation"
          value={search}
          onChange={setSearch}
          options={allEmployees}
          getLabel={(e) => `${e.full_name} (${e.employee_id})${e.designation ? ' — ' + e.designation : ''}`}
          getValue={(e) => e.employee_id}
          getKey={(e) => e.id}
        />
        <select value={estFilter} onChange={(e) => setEstFilter(e.target.value)}>
          <option value="">All establishments</option>
          {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
        <div className="filter-count-badge">
          <strong>{rows.length}</strong>{' '}
          {statusFilter === 'ACTIVE' ? 'Active' : statusFilter === 'INACTIVE' ? 'Inactive' : 'Total'} Employees
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{selectedIds.length} selected</strong>
          <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => bulkSetStatus('ACTIVE')}>Reactivate</button>
          <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => bulkSetStatus('INACTIVE')}>Deactivate</button>
          <button className="btn btn-outline btn-sm btn-danger-outline" disabled={bulkBusy} onClick={bulkDelete}>Delete selected</button>
          <button className="link-btn" onClick={() => setSelectedIds([])}>Clear selection</button>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 32 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
              <th>Employee ID</th><th>Name</th><th>Designation</th><th>Establishment</th>
              <th>Bank A/C</th><th>App Access</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={selectedIds.includes(r.id)} onChange={() => toggleOne(r.id)} /></td>
                <td>{r.employee_id}</td>
                <td>
                  <div>{r.full_name}</div>
                  <div className="muted small">{r.relative_name}</div>
                </td>
                <td>{r.designation || '-'}</td>
                <td className="nowrap">{r.establishment_name}</td>
                <td>{r.bank_account_no ? `******${r.bank_account_no.slice(-4)}` : '-'}</td>
                <td>
                  {r.app_access === 'YES' ? (
                    <div>
                      <div>Yes</div>
                      <div className="muted small">{SALARY_ACCESS_LABELS[r.salary_slip_access] || r.salary_slip_access}</div>
                    </div>
                  ) : (
                    <span className="muted">No</span>
                  )}
                </td>
                <td>
                  <div className="toggle-cell">
                    <Toggle checked={r.status === 'ACTIVE'} onChange={() => toggleStatus(r)} />
                    <StatusBadge status={r.status} />
                  </div>
                </td>
                <td className="nowrap">
                  <button className="link-btn" onClick={() => openEdit(r)}>Edit</button>
                  <button className="link-btn" onClick={() => openHistory(r)}>History</button>
                  {isAdmin && r.app_access === 'YES' && (
                    <button className="link-btn" onClick={() => resetPassword(r)}>Reset Password</button>
                  )}
                  <button className="link-btn danger" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="muted">No employees found.</td></tr>}
          </tbody>
        </table>
        <div className="muted small" style={{ padding: '8px 4px' }}>Showing 1-{rows.length} of {rows.length}</div>
      </div>

      {modalOpen && (
        <Modal title={editing ? 'Edit employee' : 'Add employee'} onClose={() => setModalOpen(false)}>
          <form onSubmit={submit} className="form-grid">
            {error && <div className="alert alert-error span-2">{error}</div>}

            <div>
              <label>Employee ID</label>
              <input value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} required />
            </div>
            <div>
              <label>Full name</label>
              <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
            </div>

            <div>
              <label>Father's / Mother's / Spouse's name</label>
              <input value={form.relative_name || ''} onChange={(e) => setForm({ ...form, relative_name: e.target.value })} />
            </div>
            <div>
              <label>Relation</label>
              <select value={form.relation || ''} onChange={(e) => setForm({ ...form, relation: e.target.value })}>
                <option value="">Select</option>
                <option>Father</option>
                <option>Mother</option>
                <option>Spouse</option>
              </select>
            </div>

            <div>
              <label>Designation</label>
              <input value={form.designation || ''} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
            </div>
            <div>
              <label>UAN</label>
              <input
                value={form.uan || ''}
                onChange={(e) => setForm({ ...form, uan: e.target.value.replace(/\D/g, '').slice(0, 12) })}
                inputMode="numeric"
                pattern="\d{12}"
                maxLength={12}
                title="UAN must be exactly 12 digits"
                required
              />
            </div>

            <div>
              <label>Bank account number</label>
              <input value={form.bank_account_no || ''} onChange={(e) => setForm({ ...form, bank_account_no: e.target.value })} />
            </div>
            <div>
              <label>Establishment</label>
              <select value={form.establishment_id || ''} onChange={(e) => setForm({ ...form, establishment_id: e.target.value })} required>
                <option value="">Select establishment</option>
                {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>

            <div>
              <label>Active from</label>
              <input type="date" value={form.active_from || ''} onChange={(e) => setForm({ ...form, active_from: e.target.value })} />
            </div>
            <div>
              <label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="ACTIVE">On rolls</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>

            <div>
              <label>Email (optional)</label>
              <input type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label>App access</label>
              <select value={form.app_access || 'NO'} onChange={(e) => setForm({ ...form, app_access: e.target.value })}>
                <option value="NO">No</option>
                <option value="YES">Yes</option>
              </select>
            </div>

            {form.app_access === 'YES' && (
              <div className="span-2">
                <label>Salary slip access</label>
                <select value={form.salary_slip_access || 'VIEW_ONLY'} onChange={(e) => setForm({ ...form, salary_slip_access: e.target.value })}>
                  <option value="VIEW_ONLY">View only</option>
                  <option value="VIEW_DOWNLOAD">View and download</option>
                </select>
              </div>
            )}

            <div className="span-2 modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="btn btn-primary">{editing ? 'Save changes' : 'Add employee'}</button>
            </div>
          </form>
        </Modal>
      )}

      {historyFor && (
        <Modal title={`Posting history — ${historyFor.full_name}`} onClose={() => setHistoryFor(null)}>
          <table className="table">
            <thead><tr><th>Establishment</th><th>From</th><th>To</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{h.establishment_name}</td>
                  <td>{h.active_from?.slice(0, 10) || '-'}</td>
                  <td>{h.active_to?.slice(0, 10) || 'Present'}</td>
                </tr>
              ))}
              {!history.length && <tr><td colSpan={3} className="muted">No history recorded.</td></tr>}
            </tbody>
          </table>
        </Modal>
      )}
    </Layout>
  );
}
