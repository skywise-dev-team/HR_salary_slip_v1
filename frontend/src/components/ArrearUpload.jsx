import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import Pagination from './Pagination.jsx';
import EmployeePicker from './EmployeePicker.jsx';
import SearchAutocomplete from './SearchAutocomplete.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';
import { useImportSlot } from '../context/ImportContext.jsx';
import { formatINR } from '../utils/formatCurrency.js';
import { streamImport } from '../utils/importProgress.js';
import { showResultToast } from '../utils/approvalToast.js';
import { API_BASE } from '../config/apiBase.js';

// First day allowed for a date of issue: the day after the arrear "to" month ends.
const issueMin = (m, y) => {
  const mm = Number(m); const yy = Number(y);
  if (!mm || !yy) return undefined;
  return mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
};

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const FIGURE_FIELDS = [
  ['paid_days', 'Paid days'], ['basic', 'Basic'], ['hra', 'HRA'], ['da', 'DA'],
  ['conveyance_allowance', 'Conveyance Allowance'], ['overtime', 'Overtime'],
  ['pf_deduction', 'PF deduction'], ['esi_deduction', 'ESI deduction'], ['pt_deduction', 'P-Tax deduction'],
  ['tds_deduction', 'TDS deduction'], ['other_deduction', 'Other deduction']
];

// Today's date (local) as yyyy-mm-dd - the default date of issue.
const todayInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const emptyForm = () => {
  const f = {
    establishment_id: '', employee_id: '',
    arrear_from_month: '', arrear_from_year: new Date().getFullYear(),
    arrear_to_month: '', arrear_to_year: new Date().getFullYear(),
    date_of_issue: todayInput()
  };
  FIGURE_FIELDS.forEach(([name]) => { f[name] = ''; });
  return f;
};

const PAGE_SIZE_OPTIONS = [50, 100, 150, 200];

// Arrear salary: the "Arrear upload" window (template, Excel upload, single
// record) and, below the normal salary table, the list of arrear records.
//   open / onClose  - the window, opened by the button on the page header
export default function ArrearUpload({ open, onClose, establishments, employees, canEdit, canDelete }) {
  const { showToast } = useToast();
  const { importing, progress, result, startImport, updateProgress, finishImport, cancelImport, clearResult } = useImportSlot('arrearData');

  const [importFile, setImportFile] = useState(null);
  const [singleOpen, setSingleOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [editRecord, setEditRecord] = useState(null); // the arrear record whose edit form is open
  const [editForm, setEditForm] = useState({});
  const [editError, setEditError] = useState('');

  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ establishment_id: '', month: '', year: '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [details, setDetails] = useState({});
  const [busy, setBusy] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState([]);      // group keys ticked
  const [selectedRecords, setSelectedRecords] = useState({});    // group key -> ids ticked
  const [groupSearch, setGroupSearch] = useState({});
  const [groupPage, setGroupPage] = useState({});
  const [groupPageSize, setGroupPageSize] = useState({});
  const canSelect = canDelete;

  const groupKey = (r) => `${r.establishment_id}-${r.arrear_from_month}-${r.arrear_from_year}-${r.arrear_to_month}-${r.arrear_to_year}`;
  const periodText = (r) => `${MONTHS[r.arrear_from_month]} ${r.arrear_from_year} to ${MONTHS[r.arrear_to_month]} ${r.arrear_to_year}`;
  const paramsOf = (extra = {}) => {
    const params = { ...extra };
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    return params;
  };

  const load = () => api.get('/api/arrear-data/summary', { params: paramsOf() })
    .then(({ data }) => { setRows(data); setPage(1); })
    .catch(() => setRows([]));
  useEffect(() => { load(); setDetails({}); setExpanded(new Set()); }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchGroup = (r) => api.get('/api/arrear-data', {
    params: {
      establishment_id: r.establishment_id,
      month: r.arrear_from_month, year: r.arrear_from_year,
      to_month: r.arrear_to_month, to_year: r.arrear_to_year
    }
  }).then(({ data }) => data);

  const toggleExpand = async (r) => {
    const key = groupKey(r);
    setExpanded((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
    if (!details[key]) {
      const data = await fetchGroup(r);
      setDetails((prev) => ({ ...prev, [key]: data }));
    }
  };

  const refreshAfterChange = async () => {
    setDetails({});
    setExpanded(new Set());
    setSelectedGroups([]);
    setSelectedRecords({});
    await load();
  };

  const downloadTemplate = () => {
    const token = localStorage.getItem('token');
    window.open(`${API_BASE}/api/arrear-data/template?token=${token}`, '_blank');
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
      const { status } = await streamImport(api, '/api/arrear-data/import', fd, {
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
          showToast(`Imported ${finalResult.inserted || 0} arrear record(s).`);
          refreshAfterChange();
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

  const openSingle = () => { setForm(emptyForm()); setError(''); setSingleOpen(true); };

  const submitSingle = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await api.post('/api/arrear-data', form);
      setSingleOpen(false);
      showResultToast(showToast, res, 'Arrear record saved successfully!');
      refreshAfterChange();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    }
  };

  // dd-mm-yyyy text from the server -> yyyy-mm-dd for the date box.
  const toDateInput = (text) => {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text || '');
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  };

  const openEditRecord = (rec) => {
    const values = {
      arrear_from_month: rec.arrear_from_month, arrear_from_year: rec.arrear_from_year,
      arrear_to_month: rec.arrear_to_month, arrear_to_year: rec.arrear_to_year,
      date_of_issue: toDateInput(rec.date_of_issue_text)
    };
    FIGURE_FIELDS.forEach(([name]) => { values[name] = rec[name] ?? ''; });
    setEditForm(values);
    setEditError('');
    setEditRecord(rec);
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    setEditError('');
    try {
      const res = await api.put(`/api/arrear-data/${editRecord.id}`, editForm);
      setEditRecord(null);
      showResultToast(showToast, res, 'Arrear record updated.');
      refreshAfterChange();
    } catch (err) {
      setEditError(err.response?.data?.message || 'Save failed');
    }
  };

  const deleteIds = async (ids, text) => {
    if (!ids.length) return;
    if (!confirm(text)) return;
    setBusy(true);
    try {
      const res = await api.delete('/api/arrear-data/records', { data: { ids } });
      showResultToast(showToast, res, 'Deleted successfully!');
      await refreshAfterChange();
    } catch (err) {
      showToast(err.response?.data?.message || 'Delete failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const deleteRecord = (rec) => deleteIds([rec.id],
    `Delete the arrear record of ${rec.full_name} (${rec.emp_code}) — arrear for ${periodText(rec)}? This cannot be undone.`);

  const deleteGroup = async (r) => {
    const data = details[groupKey(r)] || await fetchGroup(r);
    await deleteIds(data.map((x) => x.id),
      `Delete all ${data.length} arrear record(s) for ${r.establishment_name} — arrear for ${periodText(r)}? This cannot be undone.`);
  };

  const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);

  const toggleGroup = (key) => setSelectedGroups((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  const toggleAllGroups = () => setSelectedGroups((prev) => {
    const shown = rows.map(groupKey);
    const allShown = shown.length > 0 && shown.every((k) => prev.includes(k));
    return allShown ? prev.filter((k) => !shown.includes(k)) : [...new Set([...prev, ...shown])];
  });

  // Deletes every record of all the ticked groups - including ones ticked under
  // a different filter (a group key is "<est>-<from m>-<from y>-<to m>-<to y>").
  const bulkDeleteGroups = async () => {
    const chosen = selectedGroups.map((k) => {
      const [establishment_id, arrear_from_month, arrear_from_year, arrear_to_month, arrear_to_year] = k.split('-').map(Number);
      return { establishment_id, arrear_from_month, arrear_from_year, arrear_to_month, arrear_to_year };
    });
    if (!chosen.length) return;
    const lists = await Promise.all(chosen.map((r) => details[groupKey(r)] || fetchGroup(r)));
    const ids = lists.flat().map((x) => x.id);
    await deleteIds(ids,
      `Delete all arrear records (${ids.length}) of the ${chosen.length} selected establishment/period group(s)? This cannot be undone.`);
  };

  const toggleRecord = (key, id) => setSelectedRecords((prev) => {
    const current = prev[key] || [];
    return { ...prev, [key]: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] };
  });

  // Ticks / un-ticks every employee matching this group's search, across all pages.
  const toggleAllRecords = (key, visibleIds) => setSelectedRecords((prev) => {
    const current = prev[key] || [];
    const allTicked = visibleIds.length > 0 && visibleIds.every((id) => current.includes(id));
    return { ...prev, [key]: allTicked ? current.filter((id) => !visibleIds.includes(id)) : [...new Set([...current, ...visibleIds])] };
  });

  const deleteSelectedRecords = (key, r) => deleteIds(selectedRecords[key] || [],
    `Delete ${(selectedRecords[key] || []).length} selected arrear record(s) for ${r.establishment_name} — arrear for ${periodText(r)}? This cannot be undone.`);

  // Same columns as the arrear import template - edit in Excel, upload back.
  const exportGroup = (r) => {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams({
      establishment_id: r.establishment_id, month: r.arrear_from_month, year: r.arrear_from_year,
      to_month: r.arrear_to_month, to_year: r.arrear_to_year, token
    });
    window.open(`${API_BASE}/api/arrear-data/export?${params.toString()}`, '_blank');
  };

  return (
    <>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Arrear records</h3>
        <div className="filter-bar">
          <select value={filters.establishment_id} onChange={(e) => setFilters({ ...filters, establishment_id: e.target.value })}>
            <option value="">All establishments</option>
            {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <select value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value })}>
            <option value="">All "from" months</option>
            {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
          </select>
          <input placeholder="From year" style={{ width: 100 }} value={filters.year} onChange={(e) => setFilters({ ...filters, year: e.target.value })} />
        </div>
        {selectedGroups.length > 0 && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <span>{selectedGroups.length} selected</span>
            <button className="btn btn-outline btn-sm btn-danger-outline" disabled={busy} onClick={bulkDeleteGroups}>Delete selected</button>
            <button className="btn btn-outline btn-sm" onClick={() => setSelectedGroups([])}>Clear selection</button>
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              {canSelect && (
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={rows.length > 0 && rows.every((r) => selectedGroups.includes(groupKey(r)))} onChange={toggleAllGroups} />
                </th>
              )}
              <th style={{ width: 24 }}></th>
              <th>Establishment</th><th>Arrear period</th><th>No. of arrear records</th><th>Total net pay</th>
              {canDelete && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pagedRows.flatMap((r) => {
              const key = groupKey(r);
              const isOpen = expanded.has(key);
              const list = details[key];
              const search = (groupSearch[key] || '').trim().toLowerCase();
              const visible = list && search
                ? list.filter((x) => x.full_name.toLowerCase().includes(search) || x.emp_code.toLowerCase().includes(search))
                : list;
              const gPage = groupPage[key] || 1;
              const gPageSize = groupPageSize[key] || PAGE_SIZE_OPTIONS[0];
              const paged = visible ? visible.slice((gPage - 1) * gPageSize, gPage * gPageSize) : visible;
              const selectedHere = selectedRecords[key] || [];
              const visibleIds = visible ? visible.map((x) => x.id) : [];
              const colCount = (canSelect ? 1 : 0) + 5 + (canDelete ? 1 : 0);
              const out = [
                <tr key={key}>
                  {canSelect && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedGroups.includes(key)} onChange={() => toggleGroup(key)} />
                    </td>
                  )}
                  <td onClick={() => toggleExpand(r)} style={{ cursor: 'pointer' }}>{isOpen ? '▾' : '▸'}</td>
                  <td className="nowrap" onClick={() => toggleExpand(r)} style={{ cursor: 'pointer' }}>{r.establishment_name}</td>
                  <td onClick={() => toggleExpand(r)} style={{ cursor: 'pointer' }}>{periodText(r)}</td>
                  <td>{r.record_count}</td>
                  <td>{formatINR(r.total_net_pay)}</td>
                  {canDelete && <td><button className="link-btn danger" disabled={busy} onClick={() => deleteGroup(r)}>Delete</button></td>}
                </tr>
              ];
              if (isOpen) {
                out.push(
                  <tr key={`${key}-detail`}>
                    <td colSpan={colCount} style={{ padding: 0 }}>
                      <div style={{ padding: '8px 16px 16px 40px', background: 'var(--bg)' }}>
                        {!list ? <p className="muted">Loading...</p> : (
                          <>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <SearchAutocomplete
                                placeholder="Employee name or ID"
                                value={groupSearch[key] || ''}
                                onChange={(v) => { setGroupSearch({ ...groupSearch, [key]: v }); setGroupPage({ ...groupPage, [key]: 1 }); }}
                                options={list}
                                getLabel={(x) => `${x.full_name} (${x.emp_code})`}
                                getValue={(x) => x.emp_code}
                                getKey={(x) => x.id}
                              />
                              <button
                                type="button"
                                className="btn btn-outline btn-sm"
                                onClick={() => exportGroup(r)}
                                title="Same columns as the arrear import template - edit it in Excel, then upload it back"
                              >
                                Download as Excel
                              </button>
                              {canSelect && selectedHere.length > 0 && (
                                <>
                                  <span>{selectedHere.length} selected</span>
                                  <button type="button" className="btn btn-outline btn-sm btn-danger-outline" disabled={busy} onClick={() => deleteSelectedRecords(key, r)}>
                                    Delete selected ({selectedHere.length})
                                  </button>
                                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setSelectedRecords({ ...selectedRecords, [key]: [] })}>Clear</button>
                                </>
                              )}
                            </div>
                            <table className="table" style={{ marginTop: 10 }}>
                              <thead>
                                <tr>
                                  {canSelect && (
                                    <th style={{ width: 32 }}>
                                      <input
                                        type="checkbox"
                                        checked={visibleIds.length > 0 && visibleIds.every((id) => selectedHere.includes(id))}
                                        onChange={() => toggleAllRecords(key, visibleIds)}
                                      />
                                    </th>
                                  )}
                                  <th>Employee</th><th>Date of issue</th><th>Net pay</th>{(canEdit || canDelete) && <th>Actions</th>}
                                </tr>
                              </thead>
                              <tbody>
                                {paged.map((x) => (
                                  <tr key={x.id}>
                                    {canSelect && (
                                      <td><input type="checkbox" checked={selectedHere.includes(x.id)} onChange={() => toggleRecord(key, x.id)} /></td>
                                    )}
                                    <td>{x.full_name} <span className="muted small">({x.emp_code})</span></td>
                                    <td>{x.date_of_issue_text || '—'}</td>
                                    <td>{formatINR(x.net_pay)}</td>
                                    {(canEdit || canDelete) && (
                                      <td>
                                        {canEdit && <button className="link-btn" disabled={busy} onClick={() => openEditRecord(x)}>Edit</button>}
                                        {canDelete && <button className="link-btn danger" disabled={busy} onClick={() => deleteRecord(x)}>Delete</button>}
                                      </td>
                                    )}
                                  </tr>
                                ))}
                                {!visible.length && <tr><td colSpan={(canSelect ? 1 : 0) + 3 + ((canEdit || canDelete) ? 1 : 0)} className="muted">No matching employees.</td></tr>}
                              </tbody>
                            </table>
                            <Pagination
                              page={gPage}
                              setPage={(p) => setGroupPage({ ...groupPage, [key]: p })}
                              pageSize={gPageSize}
                              setPageSize={(s) => setGroupPageSize({ ...groupPageSize, [key]: s })}
                              totalItems={visible.length}
                              pageSizeOptions={PAGE_SIZE_OPTIONS}
                            />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              }
              return out;
            })}
            {!rows.length && <tr><td colSpan={(canSelect ? 1 : 0) + 5 + (canDelete ? 1 : 0)} className="muted">No arrear data yet.</td></tr>}
          </tbody>
        </table>
        <Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalItems={rows.length} pageSizeOptions={PAGE_SIZE_OPTIONS} />
      </div>

      {open && (
        <Modal title="Arrear salary upload" onClose={onClose} width={720}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <button type="button" className="btn btn-outline" onClick={downloadTemplate}>Download arrear template</button>
            <button type="button" className="btn btn-outline" onClick={() => { onClose(); openSingle(); }} disabled={!canEdit}>Add single arrear record</button>
          </div>

          <h4 style={{ marginTop: 20 }}>Bulk upload from Excel</h4>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" accept=".xlsx" onChange={(e) => { setImportFile(e.target.files[0]); clearResult(); }} />
            <button className="btn btn-primary" onClick={runImport} disabled={!importFile || importing || !canEdit}>
              {importing ? 'Importing...' : 'Import arrear from Excel'}
            </button>
            {importing && <button type="button" className="btn btn-outline btn-danger-outline" onClick={cancelImport}>Cancel</button>}
          </div>
          {importing && progress && (
            <div className="import-progress">
              <div className="import-progress-track"><div className="import-progress-fill" style={{ width: `${progress.percent}%` }} /></div>
              <span className="import-progress-label">{progress.percent}% ({progress.processed}/{progress.total} rows)</span>
            </div>
          )}
          {result && (
            <div className="alert alert-info" style={{ marginTop: 12, whiteSpace: 'pre-line' }}>
              Inserted/updated: {result.inserted || 0}, skipped: {result.skipped || 0}
              {result.errors?.length > 0 && <ul>{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
            </div>
          )}
        </Modal>
      )}

      {singleOpen && (
        <Modal title="Add arrear record" onClose={() => setSingleOpen(false)} width={760}>
          <form onSubmit={submitSingle} className="form-grid">
            {error && <div className="alert alert-error span-2" style={{ whiteSpace: 'pre-line' }}>{error}</div>}
            <div>
              <label>Establishment</label>
              <select value={form.establishment_id} onChange={(e) => setForm({ ...form, establishment_id: e.target.value, employee_id: '' })} required>
                <option value="">Select</option>
                {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div>
              <label>Employee</label>
              <EmployeePicker
                required
                value={form.employee_id}
                onChange={(id) => setForm({ ...form, employee_id: id })}
                options={employees.filter((e) => !form.establishment_id || String(e.establishment_id) === String(form.establishment_id))}
              />
            </div>
            <div>
              <label>Arrear from — month</label>
              <select value={form.arrear_from_month} onChange={(e) => setForm({ ...form, arrear_from_month: e.target.value })} required>
                <option value="">Select</option>
                {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label>Arrear from — year</label>
              <input type="number" min="1000" max="9999" step="1" value={form.arrear_from_year} onChange={(e) => setForm({ ...form, arrear_from_year: e.target.value })} required />
            </div>
            <div>
              <label>Arrear to — month</label>
              <select value={form.arrear_to_month} onChange={(e) => setForm({ ...form, arrear_to_month: e.target.value })} required>
                <option value="">Select</option>
                {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label>Arrear to — year</label>
              <input type="number" min="1000" max="9999" step="1" value={form.arrear_to_year} onChange={(e) => setForm({ ...form, arrear_to_year: e.target.value })} required />
            </div>
            <div>
              <label>Date of issue (printed on the slip)</label>
              <input type="date" value={form.date_of_issue} min={issueMin(form.arrear_to_month, form.arrear_to_year)} max={new Date().toLocaleDateString('en-CA')} onChange={(e) => setForm({ ...form, date_of_issue: e.target.value })} required />
            </div>
            {FIGURE_FIELDS.map(([name, label]) => (
              <div key={name}>
                <label>{label}</label>
                <input type="number" step={name === 'paid_days' ? '0.5' : '0.01'} min={name === 'basic' ? '0.01' : '0'} required value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })} />
              </div>
            ))}
            <div className="span-2 modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setSingleOpen(false)}>Cancel</button>
              <button className="btn btn-primary">Save arrear record</button>
            </div>
          </form>
        </Modal>
      )}

      {editRecord && (
        <Modal
          title={`Edit arrear record — ${editRecord.full_name} (${editRecord.emp_code})`}
          onClose={() => setEditRecord(null)}
          width={760}
        >
          <form onSubmit={submitEdit} className="form-grid">
            {editError && <div className="alert alert-error span-2" style={{ whiteSpace: 'pre-line' }}>{editError}</div>}
            <div>
              <label>Arrear from — month</label>
              <select value={editForm.arrear_from_month} onChange={(e) => setEditForm({ ...editForm, arrear_from_month: e.target.value })} required>
                <option value="">Select</option>
                {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label>Arrear from — year</label>
              <input type="number" min="1000" max="9999" step="1" value={editForm.arrear_from_year} onChange={(e) => setEditForm({ ...editForm, arrear_from_year: e.target.value })} required />
            </div>
            <div>
              <label>Arrear to — month</label>
              <select value={editForm.arrear_to_month} onChange={(e) => setEditForm({ ...editForm, arrear_to_month: e.target.value })} required>
                <option value="">Select</option>
                {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label>Arrear to — year</label>
              <input type="number" min="1000" max="9999" step="1" value={editForm.arrear_to_year} onChange={(e) => setEditForm({ ...editForm, arrear_to_year: e.target.value })} required />
            </div>
            <div className="span-2">
              <label>Date of issue (printed on the slip)</label>
              <input type="date" value={editForm.date_of_issue} min={issueMin(editForm.arrear_to_month, editForm.arrear_to_year)} max={new Date().toLocaleDateString('en-CA')} onChange={(e) => setEditForm({ ...editForm, date_of_issue: e.target.value })} required />
            </div>
            {FIGURE_FIELDS.map(([name, label]) => (
              <div key={name}>
                <label>{label}</label>
                <input
                  type="number"
                  step={name === 'paid_days' ? '0.5' : '0.01'}
                  min={name === 'basic' ? '0.01' : '0'}
                  required
                  value={editForm[name]}
                  onChange={(e) => setEditForm({ ...editForm, [name]: e.target.value })}
                />
              </div>
            ))}
            <div className="span-2 modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setEditRecord(null)}>Cancel</button>
              <button className="btn btn-primary">Save changes</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
