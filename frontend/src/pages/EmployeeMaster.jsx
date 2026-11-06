import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import { Toggle, StatusBadge } from '../components/Toggle.jsx';
import SearchAutocomplete from '../components/SearchAutocomplete.jsx';
import Pagination from '../components/Pagination.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useImportSlot } from '../context/ImportContext.jsx';
import { showResultToast } from '../utils/approvalToast.js';
import { streamImport } from '../utils/importProgress.js';
import { API_BASE } from '../config/apiBase.js';

const EMPTY = {
  employee_id: '', full_name: '', relative_name: '', relation: '', designation: '',
  uan: '', bank_account_no: '', establishment_id: '', active_from: '', inactive_date: '', status: 'ACTIVE',
  email: '', app_access: 'NO', salary_slip_access: 'VIEW_ONLY'
};

const SALARY_ACCESS_LABELS = {
  VIEW_DOWNLOAD: 'View & download',
  VIEW_ONLY: 'View only',
  NO_ACCESS: 'No access'
};

const PAGE_SIZE_OPTIONS = [50, 100, 150, 200];

// Today as yyyy-mm-dd (local time) - the default "Effective from" date.
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const [exportFor, setExportFor] = useState(null);        // { ids: number[] | null, label } while the export window is open
  const [exportMode, setExportMode] = useState('changes'); // 'changes' | 'current'
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const { showToast } = useToast();
  const { isAdmin } = useAuth();

  const load = () => {
    const params = {};
    if (search) params.search = search;
    if (estFilter) params.establishment_id = estFilter;
    if (statusFilter) params.status = statusFilter;
    api.get('/api/employees', { params }).then(({ data }) => setRows(data));   // ticked employees stay ticked across searches / filters
  };

  useEffect(() => {
    api.get('/api/establishments').then(({ data }) => setEstablishments(data));
    api.get('/api/employees').then(({ data }) => setAllEmployees(data));
  }, []);
  // Whenever the underlying filtered set changes, jump back to page 1 —
  // otherwise a narrower search could leave the view stranded on a page
  // number that no longer has any rows on it.
  useEffect(() => { load(); setPage(1); }, [search, estFilter, statusFilter]);

  const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);

  const reactivating = !!editing && editing.status === 'INACTIVE' && form.status === 'ACTIVE';
  const refreshAllEmployees = () => api.get('/api/employees').then(({ data }) => setAllEmployees(data));

  const openAdd = () => { setEditing(null); setForm({ ...EMPTY, effective_date: todayStr() }); setError(''); setModalOpen(true); };
  const openEdit = (row) => {
    setEditing(row);
    setForm({ ...row, active_from: row.active_from ? row.active_from.slice(0, 10) : '', inactive_date: row.inactive_date ? row.inactive_date.slice(0, 10) : '', effective_date: (() => { const af = row.active_from ? row.active_from.slice(0, 10) : ''; const last = row.last_effective_date || ''; return last && last >= af ? last : (af || todayStr()); })() });
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

  // App access on / off. Turning it on gives the employee View only access to
  // salary slips; the download right is then given on the Edit form. Active /
  // Inactive is changed only on the Edit form.
  const toggleAppAccess = async (row) => {
    const next = row.app_access === 'YES' ? 'NO' : 'YES';
    const note = next === 'YES' ? ' They will be given View only access to salary slips.' : ' Their login will be removed.';
    if (!confirm(`Turn app access ${next === 'YES' ? 'ON' : 'OFF'} for "${row.full_name}"?${note}`)) return;
    try {
      const res = await api.patch(`/api/employees/${row.id}/app-access`, { app_access: next });
      showResultToast(showToast, res, `App access turned ${next === 'YES' ? 'on' : 'off'}.`);
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not change app access', 'error');
    }
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
  // Header tick works on the employees currently listed; anyone ticked earlier
  // (e.g. under a different search) stays ticked.
  const toggleAll = () => setSelectedIds((ids) => {
    const shown = rows.map((r) => r.id);
    return allSelected ? ids.filter((id) => !shown.includes(id)) : [...new Set([...ids, ...shown])];
  });

  const bulkSetAppAccess = async (access) => {
    if (!selectedIds.length) return;
    const note = access === 'YES' ? ' They will be given View only access to salary slips (inactive employees are skipped).' : ' Their logins will be removed.';
    if (!confirm(`Turn app access ${access === 'YES' ? 'ON' : 'OFF'} for ${selectedIds.length} selected employee(s)?${note}`)) return;
    setBulkBusy(true);
    try {
      const res = await api.patch('/api/employees/bulk/app-access', { ids: selectedIds, app_access: access });
      showResultToast(showToast, res, res.data?.message || 'Updated successfully!');
      setSelectedIds([]);
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
      setSelectedIds([]);
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
    const base = API_BASE;
    window.open(`${base}/api/employees/template?token=${token}`, '_blank');
  };

  // "Export to Excel" (top button, or the Export link on a row) first asks
  // what to export - the full change history or only today's details - and
  // then builds the file. ids = the employees to export; null = everyone the
  // current search/filters show.
  const openExport = (ids, label) => {
    setExportMode('changes');
    setExportFor({ ids, label });
  };

  const runExport = async () => {
    if (!exportFor) return;
    setExporting(true);
    try {
      const body = { mode: exportMode };
      if (exportFor.ids) body.ids = exportFor.ids;
      else {
        if (search) body.search = search;
        if (estFilter) body.establishment_id = estFilter;
        if (statusFilter) body.status = statusFilter;
      }
      const res = await api.post('/api/employees/export', body, { responseType: 'blob' });
      const disposition = res.headers?.['content-disposition'] || '';
      const named = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = named ? named[1] : `employees-${exportMode === 'changes' ? 'with-changes' : 'current-details'}.xlsx`;
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportFor(null);
    } catch (err) {
      showToast('Could not create the Excel file. Please try again.', 'error');
    } finally {
      setExporting(false);
    }
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
          <button
            className="btn btn-outline"
            onClick={() => (selectedIds.length
              ? openExport(selectedIds, `${selectedIds.length} selected employee(s)`)
              : openExport(null, `All ${rows.length} employee(s) shown by the current search and filters`))}
          >
            Export to Excel
          </button>
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
          <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => bulkSetAppAccess('YES')}>App access: Yes</button>
          <button className="btn btn-outline btn-sm" disabled={bulkBusy} onClick={() => bulkSetAppAccess('NO')}>App access: No</button>
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
            {pagedRows.map((r) => (
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
                  <div className="toggle-cell">
                    <Toggle checked={r.app_access === 'YES'} disabled={r.status !== 'ACTIVE' && r.app_access !== 'YES'} onChange={() => toggleAppAccess(r)} />
                    {r.app_access === 'YES' ? (
                      <div>
                        <div>Yes</div>
                        <div className="muted small">{SALARY_ACCESS_LABELS[r.salary_slip_access] || r.salary_slip_access}</div>
                      </div>
                    ) : (
                      <span className="muted">No</span>
                    )}
                  </div>
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="nowrap">
                  <button className="link-btn" onClick={() => openEdit(r)}>Edit</button>
                  <button className="link-btn" onClick={() => openHistory(r)}>History</button>
                  <button className="link-btn" onClick={() => openExport([r.id], `${r.full_name} (${r.employee_id})`)}>Export</button>
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
        <Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalItems={rows.length} pageSizeOptions={PAGE_SIZE_OPTIONS} />
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
              <input value={form.relative_name || ''} onChange={(e) => setForm({ ...form, relative_name: e.target.value })} required={!editing} />
            </div>
            <div>
              <label>Relation</label>
              <select value={form.relation || ''} onChange={(e) => setForm({ ...form, relation: e.target.value })} required={!editing}>
                <option value="">Select</option>
                <option>Father</option>
                <option>Mother</option>
                <option>Spouse</option>
              </select>
            </div>

            <div>
              <label>Designation</label>
              <input value={form.designation || ''} onChange={(e) => setForm({ ...form, designation: e.target.value })} required={!editing} />
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
              <input value={form.bank_account_no || ''} onChange={(e) => setForm({ ...form, bank_account_no: e.target.value })} required={!editing} />
            </div>
            <div>
              <label>Establishment</label>
              <select value={form.establishment_id || ''} onChange={(e) => setForm({ ...form, establishment_id: e.target.value })} required>
                <option value="">Select establishment</option>
                {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>

            <div>
              <label>{reactivating ? 'Active from (new date)' : 'Active from'}</label>
              <input type="date" value={form.active_from || ''} max={todayStr()} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, active_from: v, effective_date: v && f.effective_date && f.effective_date < v ? v : f.effective_date })); }} required={!editing || reactivating} />
            </div>
            <div>
              <label>Status</label>
              <select
                value={form.status}
                onChange={(e) => {
                  const status = e.target.value;
                  setForm((f) => {
                    const next = { ...f, status, inactive_date: status === 'INACTIVE' ? (f.inactive_date || todayStr()) : '' };
                    if (status === 'INACTIVE') next.app_access = 'NO';
                    // Made active again: the Active-from date is asked (left blank to be filled in).
                    if (editing && editing.status === 'INACTIVE') {
                      next.active_from = status === 'ACTIVE' ? '' : (editing.active_from ? editing.active_from.slice(0, 10) : '');
                    }
                    return next;
                  });
                }}
              >
                <option value="ACTIVE">On rolls</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
            {form.status === 'INACTIVE' && (
              <div>
                <label>Inactive date</label>
                <input type="date" value={form.inactive_date || ''} min={form.active_from || undefined} max={todayStr()} onChange={(e) => setForm({ ...form, inactive_date: e.target.value })} required />
              </div>
            )}

            {editing && (
              <div className="span-2">
                <label>Effective from</label>
                <input type="date" value={form.effective_date || ''} min={form.active_from || undefined} max={todayStr()} onChange={(e) => setForm({ ...form, effective_date: e.target.value })} required />
              </div>
            )}
            <div>
              <label>Email (optional)</label>
              <input type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label>App access</label>
              <select value={form.app_access || 'NO'} disabled={form.status === 'INACTIVE'} onChange={(e) => setForm({ ...form, app_access: e.target.value })}>
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

      {exportFor && (
        <Modal title="Export to Excel" onClose={() => !exporting && setExportFor(null)} width={560}>
          <p style={{ marginTop: 0 }}><strong>Exporting:</strong> {exportFor.label}</p>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 10, cursor: 'pointer', margin: '12px 0', fontWeight: 400 }}>
            <input type="radio" name="exportMode" style={{ width: 16, height: 16, marginTop: 3, flex: '0 0 16px' }}
              checked={exportMode === 'changes'} onChange={() => setExportMode('changes')} />
            <span>
              <strong>With changes</strong>
            </span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 10, cursor: 'pointer', margin: '12px 0', fontWeight: 400 }}>
            <input type="radio" name="exportMode" style={{ width: 16, height: 16, marginTop: 3, flex: '0 0 16px' }}
              checked={exportMode === 'current'} onChange={() => setExportMode('current')} />
            <span>
              <strong>Current details only</strong>
            </span>
          </label>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-outline" disabled={exporting} onClick={() => setExportFor(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={exporting} onClick={runExport}>
              {exporting ? 'Preparing...' : 'Export'}
            </button>
          </div>
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
