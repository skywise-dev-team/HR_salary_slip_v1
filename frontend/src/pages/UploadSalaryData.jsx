import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import SearchAutocomplete from '../components/SearchAutocomplete.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';
import { useImportSlot } from '../context/ImportContext.jsx';
import { formatINR } from '../utils/formatCurrency.js';
import { streamImport } from '../utils/importProgress.js';
import { showResultToast } from '../utils/approvalToast.js';

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const EMPTY = {
  establishment_id: '', employee_id: '', period_month: '', period_year: new Date().getFullYear(),
  paid_days: '', basic: '', hra: '', da: '', conveyance_allowance: '', overtime: '',
  pf_deduction: '', esi_deduction: '', pt_deduction: '', tds_deduction: '', other_deduction: ''
};

export default function UploadSalaryData() {
  const [rows, setRows] = useState([]);
  const [syncing, setSyncing] = useState(true);
  const [establishments, setEstablishments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [filters, setFilters] = useState({ establishment_id: '', month: '', year: '' });
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [importFile, setImportFile] = useState(null);
  const { importing, progress: importProgress, result: importResult, startImport, updateProgress, finishImport, cancelImport } = useImportSlot('salaryData');
  const [warning, setWarning] = useState('');
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [groupEmployees, setGroupEmployees] = useState({});
  const [groupSearch, setGroupSearch] = useState({});
  const { showToast } = useToast();

  const load = () => {
    const params = {};
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    api.get('/api/salary-data/summary', { params }).then(({ data }) => { setRows(data); setSelectedGroups([]); });
  };

  const groupKey = (r) => `${r.establishment_id}-${r.period_month}-${r.period_year}`;
  const toggleGroup = (key) => {
    setSelectedGroups((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  };
  const toggleAllGroups = () => {
    setSelectedGroups((prev) => prev.length === rows.length ? [] : rows.map(groupKey));
  };
  const groupsFromKeys = (keys) => rows
    .filter((r) => keys.includes(groupKey(r)))
    .map((r) => ({ establishment_id: r.establishment_id, period_month: r.period_month, period_year: r.period_year }));

  // Fetches this group's individual employee records only the first time
  // it's expanded (not on every toggle) — with potentially 1000+ employees
  // per establishment/period, there's no reason to load every group's
  // detail up front just to show the summary row.
  const toggleExpand = (r) => {
    const key = groupKey(r);
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    if (!groupEmployees[key]) {
      api.get('/api/salary-data', {
        params: { establishment_id: r.establishment_id, month: r.period_month, year: r.period_year }
      }).then(({ data }) => setGroupEmployees((prev) => ({ ...prev, [key]: data })));
    }
  };

  const removeRecord = async (row) => {
    if (!confirm(`Delete the salary record and slip for ${row.full_name} (${row.emp_code}) — ${MONTHS[row.period_month]} ${row.period_year}? This cannot be undone.`)) return;
    try {
      const res = await api.delete(`/api/salary-data/${row.id}`);
      showResultToast(showToast, res, 'Deleted successfully!');
      const key = groupKey(row);
      const { data: fresh } = await api.get('/api/salary-data', {
        params: { establishment_id: row.establishment_id, month: row.period_month, year: row.period_year }
      });
      setGroupEmployees((prev) => ({ ...prev, [key]: fresh }));
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Delete failed', 'error');
    }
  };

  const deleteGroup = async (r) => {
    if (!confirm(`Delete all ${r.slip_count} salary record(s) for ${r.establishment_name} — ${MONTHS[r.period_month]} ${r.period_year}? This also deletes their salary slips. This cannot be undone.`)) return;
    try {
      const res = await api.delete('/api/salary-data/groups', { data: { groups: groupsFromKeys([groupKey(r)]) } });
      showResultToast(showToast, res, 'Deleted successfully!');
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Delete failed', 'error');
    }
  };

  const bulkDeleteGroups = async () => {
    if (!confirm(`Delete all salary records for the ${selectedGroups.length} selected establishment/period group(s)? This also deletes their salary slips. This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const res = await api.delete('/api/salary-data/groups', { data: { groups: groupsFromKeys(selectedGroups) } });
      showResultToast(showToast, res, 'Deleted successfully!');
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Bulk delete failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  useEffect(() => {
    api.get('/api/establishments').then(({ data }) => setEstablishments(data));
    api.get('/api/employees').then(({ data }) => setEmployees(data));
    // Default to the most recently uploaded period instead of "All months"
    // across every establishment at once — /summary already sorts latest
    // period first, so its first row is exactly that. The table's own fetch
    // is deliberately held back (via `syncing`) until this resolves, so
    // there's never an unfiltered request in flight that could land after
    // this one and silently overwrite its correctly-filtered result.
    api.get('/api/salary-data/summary').then(({ data }) => {
      if (data.length) {
        setFilters((f) => ({ ...f, month: String(data[0].period_month), year: data[0].period_year }));
      }
      setSyncing(false);
    });
  }, []);
  useEffect(() => {
    if (syncing) return;
    load();
  }, [filters, syncing]); // eslint-disable-line react-hooks/exhaustive-deps

  const openAdd = () => { setForm(EMPTY); setError(''); setModalOpen(true); };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setWarning('');
    try {
      const res = await api.post('/api/salary-data', form);
      setModalOpen(false);
      if (res.status === 202) {
        showResultToast(showToast, res, 'Submitted for approval, pending.');
      } else if (res.data.warning) {
        setWarning(res.data.warning);
      } else {
        showToast('Salary record saved successfully!');
      }
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
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
      const { status } = await streamImport(api, '/api/salary-data/import', fd, {
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
          showToast(`Imported ${finalResult.inserted || 0} record(s), ${finalResult.slipsGenerated || 0} slip(s) generated.`);
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

  const downloadTemplate = () => {
    const token = localStorage.getItem('token');
    const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
    window.open(`${base}/api/salary-data/template?token=${token}`, '_blank');
  };

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Upload salary data</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={openAdd}>Add single record</button>
        </div>
      </div>

      {warning && <div className="alert alert-info" style={{ marginBottom: 16 }}>{warning}</div>}

      <div className="card">
        <h3>Import from Excel</h3>
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
            Inserted/updated: {importResult.inserted || 0}, slips generated: {importResult.slipsGenerated || 0}, skipped: {importResult.skipped || 0}
            {importResult.errors?.length > 0 && (
              <ul>{importResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            )}
          </div>
        )}
      </div>

      <div className="filter-bar" style={{ marginTop: 16 }}>
        <select value={filters.establishment_id} onChange={(e) => setFilters({ ...filters, establishment_id: e.target.value })}>
          <option value="">All establishments</option>
          {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value })}>
          <option value="">All months</option>
          {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
        </select>
        <input placeholder="Year" style={{ width: 100 }} value={filters.year} onChange={(e) => setFilters({ ...filters, year: e.target.value })} />
      </div>

      <div className="card">
        {selectedGroups.length > 0 && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <span>{selectedGroups.length} selected</span>
            <button className="btn btn-outline btn-sm btn-danger-outline" disabled={bulkBusy} onClick={bulkDeleteGroups}>Delete selected</button>
            <button className="btn btn-outline btn-sm" onClick={() => setSelectedGroups([])}>Clear selection</button>
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input type="checkbox" checked={rows.length > 0 && selectedGroups.length === rows.length} onChange={toggleAllGroups} />
              </th>
              <th style={{ width: 24 }}></th>
              <th>Establishment</th><th>Period</th><th>No. of salary slips generated</th><th>Total net pay</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((r) => {
              const key = groupKey(r);
              const isOpen = expandedGroups.has(key);
              const search = (groupSearch[key] || '').trim().toLowerCase();
              const employees = groupEmployees[key];
              const visibleEmployees = employees && search
                ? employees.filter((e) => e.full_name.toLowerCase().includes(search) || e.emp_code.toLowerCase().includes(search))
                : employees;

              const groupRows = [
                <tr key={key}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedGroups.includes(key)} onChange={() => toggleGroup(key)} />
                  </td>
                  <td onClick={() => toggleExpand(r)} style={{ cursor: 'pointer' }}>{isOpen ? '▾' : '▸'}</td>
                  <td className="nowrap" onClick={() => toggleExpand(r)} style={{ cursor: 'pointer' }}>{r.establishment_name}</td>
                  <td onClick={() => toggleExpand(r)} style={{ cursor: 'pointer' }}>{MONTHS[r.period_month]} {r.period_year}</td>
                  <td>{r.slip_count}</td>
                  <td>{formatINR(r.total_net_pay)}</td>
                  <td><button className="link-btn danger" onClick={() => deleteGroup(r)}>Delete</button></td>
                </tr>
              ];

              if (isOpen) {
                groupRows.push(
                  <tr key={`${key}-detail`}>
                    <td colSpan={7} style={{ padding: 0 }}>
                      <div style={{ padding: '8px 16px 16px 40px', background: 'var(--bg)' }}>
                        {!employees ? (
                          <p className="muted">Loading employees...</p>
                        ) : (
                          <>
                            <SearchAutocomplete
                              placeholder="Employee name or ID"
                              value={groupSearch[key] || ''}
                              onChange={(v) => setGroupSearch({ ...groupSearch, [key]: v })}
                              options={employees}
                              getLabel={(e) => `${e.full_name} (${e.emp_code})`}
                              getValue={(e) => e.emp_code}
                              getKey={(e) => e.id}
                            />
                            <table className="table" style={{ marginTop: 10 }}>
                              <thead>
                                <tr>
                                  <th>Employee</th><th>Net pay</th><th>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleEmployees.map((e) => (
                                  <tr key={e.id}>
                                    <td>{e.full_name} <span className="muted small">({e.emp_code})</span></td>
                                    <td>{formatINR(e.net_pay)}</td>
                                    <td>
                                      <button className="link-btn danger" onClick={() => removeRecord(e)}>Delete</button>
                                    </td>
                                  </tr>
                                ))}
                                {!visibleEmployees.length && (
                                  <tr><td colSpan={3} className="muted">No matching employees.</td></tr>
                                )}
                              </tbody>
                            </table>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              }
              return groupRows;
            })}
            {!rows.length && <tr><td colSpan={7} className="muted">No salary data yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <Modal title="Add salary record" onClose={() => setModalOpen(false)} width={760}>
          <form onSubmit={submit} className="form-grid">
            {error && <div className="alert alert-error span-2">{error}</div>}

            <div>
              <label>Establishment</label>
              <select value={form.establishment_id} onChange={(e) => setForm({ ...form, establishment_id: e.target.value })} required>
                <option value="">Select</option>
                {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div>
              <label>Employee</label>
              <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} required>
                <option value="">Select</option>
                {employees
                  .filter((e) => !form.establishment_id || String(e.establishment_id) === String(form.establishment_id))
                  .map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.employee_id})</option>)}
              </select>
            </div>

            <div>
              <label>Month</label>
              <select value={form.period_month} onChange={(e) => setForm({ ...form, period_month: e.target.value })} required>
                <option value="">Select</option>
                {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label>Year</label>
              <input type="number" min="1000" max="9999" step="1" value={form.period_year} onChange={(e) => setForm({ ...form, period_year: e.target.value })} required />
            </div>

            <div><label>Paid days</label><input type="number" step="0.5" value={form.paid_days} onChange={(e) => setForm({ ...form, paid_days: e.target.value })} /></div>
            <div><label>Basic</label><input type="number" step="0.01" value={form.basic} onChange={(e) => setForm({ ...form, basic: e.target.value })} /></div>
            <div><label>HRA</label><input type="number" step="0.01" value={form.hra} onChange={(e) => setForm({ ...form, hra: e.target.value })} /></div>
            <div><label>DA</label><input type="number" step="0.01" value={form.da} onChange={(e) => setForm({ ...form, da: e.target.value })} /></div>
            <div><label>Conveyance Allowance</label><input type="number" step="0.01" value={form.conveyance_allowance} onChange={(e) => setForm({ ...form, conveyance_allowance: e.target.value })} /></div>
            <div><label>Overtime</label><input type="number" step="0.01" value={form.overtime} onChange={(e) => setForm({ ...form, overtime: e.target.value })} /></div>
            <div><label>PF deduction</label><input type="number" step="0.01" value={form.pf_deduction} onChange={(e) => setForm({ ...form, pf_deduction: e.target.value })} /></div>
            <div><label>ESI deduction</label><input type="number" step="0.01" value={form.esi_deduction} onChange={(e) => setForm({ ...form, esi_deduction: e.target.value })} /></div>
            <div><label>P-Tax deduction</label><input type="number" step="0.01" value={form.pt_deduction} onChange={(e) => setForm({ ...form, pt_deduction: e.target.value })} /></div>
            <div><label>TDS deduction</label><input type="number" step="0.01" value={form.tds_deduction} onChange={(e) => setForm({ ...form, tds_deduction: e.target.value })} /></div>
            <div><label>Other deduction</label><input type="number" step="0.01" value={form.other_deduction} onChange={(e) => setForm({ ...form, other_deduction: e.target.value })} /></div>

            <div className="span-2 modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="btn btn-primary">Save record</button>
            </div>
          </form>
        </Modal>
      )}
    </Layout>
  );
}
