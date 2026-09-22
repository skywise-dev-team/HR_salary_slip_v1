import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import YearPicker from '../components/YearPicker.jsx';
import SearchAutocomplete from '../components/SearchAutocomplete.jsx';
import api from '../api/axios.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatINR } from '../utils/formatCurrency.js';

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

export default function SalarySlips() {
  const { user, can, refreshUser } = useAuth();
  const [syncing, setSyncing] = useState(true);

  const [slips, setSlips] = useState([]);
  const [establishments, setEstablishments] = useState([]);
  // View-only/restricted accounts (anyone without manage access) land on
  // this page with a period already selected instead of having to pick one
  // themselves — admins keep the "All months / All years" default since
  // they're typically browsing broadly. Left empty here; filled in below
  // once we know whether this login needs a default period at all.
  const [filters, setFilters] = useState({ establishment_id: '', month: '', year: '', search: '' });

  // An admin may change this account's role or salary-slip access while the
  // user already has the app open in their browser. Re-pull /me whenever
  // this page is opened so Download/Delete reflect the current permissions
  // instead of whatever was cached at login time. For a restricted login,
  // also default the period filters to the period of their own most
  // recently generated slip (falling back to the current month/year if they
  // have none yet) — the salary-slips list is already scoped to just this
  // login's own records server-side, so fetching it with no filters here is
  // safe and gives exactly the history needed to find that latest period.
  //
  // For a restricted login, the month/year selects don't apply immediately
  // like they do for a manager — they only update this "pending" selection.
  // The actual `filters` (which drives the fetch) only changes when Submit
  // is clicked, so only the very first view is auto-shown (the latest
  // period); any period change after that is explicit.
  const [pendingMonth, setPendingMonth] = useState('');
  const [pendingYear, setPendingYear] = useState('');

  useEffect(() => {
    (async () => {
      const freshUser = await refreshUser();
      const managePerm = !!freshUser?.permissions?.salary_slips?.edit;
      if (!managePerm) {
        const now = new Date();
        let month = String(now.getMonth() + 1);
        let year = now.getFullYear();
        try {
          const { data } = await api.get('/api/salary-slips');
          if (data?.length) {
            // "Latest" means the most recent pay period itself (year, then
            // month) — not whichever row happens to come back first from
            // the server. Sorting by the actual period fields is always
            // correct regardless of upload order or timing.
            const latest = [...data].sort((a, b) => {
              if (b.period_year !== a.period_year) return b.period_year - a.period_year;
              return b.period_month - a.period_month;
            })[0];
            month = String(latest.period_month);
            year = latest.period_year;
          }
        } catch { /* fall back to the current month/year computed above */ }
        setFilters((f) => ({ ...f, month, year }));
        setPendingMonth(month);
        setPendingYear(year);
      }
      setSyncing(false);
    })();
  }, [refreshUser]);

  const canManage = can('salary_slips', 'edit');   // full search/filter
  const canDownload = user?.salarySlipAccess === 'VIEW_DOWNLOAD';
  const noAccess = user?.salarySlipAccess === 'NO_ACCESS';

  const [searched, setSearched] = useState(false);
  const [previewSlip, setPreviewSlip] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);

  // View-only roles pick a period first; results only load once both are set.
  const periodReady = !canManage ? !!(filters.month && filters.year) : true;

  const loadSlips = () => {
    if (!periodReady) { setSlips([]); return; }
    const params = {};
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    api.get('/api/salary-slips', { params }).then(({ data }) => { setSlips(data); setSearched(true); });
  };

  useEffect(() => {
    if (syncing) return;
    if (canManage) {
      api.get('/api/establishments').then(({ data }) => setEstablishments(data));
    }
  }, [canManage, syncing]);

  useEffect(() => {
    if (syncing) return;
    loadSlips();
    setPreviewSlip(null);
    setSelectedIds([]);
  }, [filters, canManage, syncing]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = (slip, e) => {
    e?.stopPropagation();
    const token = localStorage.getItem('token');
    window.open(`${API_BASE}/api/salary-slips/${slip.id}/download?token=${token}`, '_blank');
  };

  const downloadAllZip = () => {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    params.set('token', token);
    window.open(`${API_BASE}/api/salary-slips/bulk-download?${params.toString()}`, '_blank');
  };

  const downloadSelectedZip = () => {
    if (!selectedIds.length) return;
    const token = localStorage.getItem('token');
    const params = new URLSearchParams();
    params.set('ids', selectedIds.join(','));
    params.set('token', token);
    window.open(`${API_BASE}/api/salary-slips/bulk-download?${params.toString()}`, '_blank');
  };

  const toggleOne = (id, e) => {
    e.stopPropagation();
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  const allSelected = slips.length > 0 && selectedIds.length === slips.length;
  const toggleAll = () => setSelectedIds(allSelected ? [] : slips.map((s) => s.id));

  const token = localStorage.getItem('token');
  const previewUrl = previewSlip
    ? `${API_BASE}/api/salary-slips/${previewSlip.id}/preview?token=${token}#toolbar=0&navpanes=0`
    : null;

  if (syncing) {
    return (
      <Layout>
        <h1 className="page-title">Salary slips</h1>
        <p className="muted">Loading your access...</p>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Salary slips</h1>
        </div>
      </div>

      {canDownload && slips.length > 0 && (
        <div style={{ marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={downloadAllZip}>
            Download all as ZIP ({slips.length}) — grouped by establishment
          </button>
          {selectedIds.length > 0 && (
            <button className="btn btn-primary" onClick={downloadSelectedZip}>
              Download selected as ZIP ({selectedIds.length})
            </button>
          )}
        </div>
      )}

      <div className="filter-bar">
        {canManage && (
          <>
            <SearchAutocomplete
              placeholder="Employee name or ID"
              value={filters.search}
              onChange={(v) => setFilters({ ...filters, search: v })}
              options={Array.from(new Map(slips.map((s) => [s.emp_code, s])).values())}
              getLabel={(s) => `${s.full_name} (${s.emp_code})`}
              getValue={(s) => s.emp_code}
              getKey={(s) => s.emp_code}
            />
            <select value={filters.establishment_id} onChange={(e) => setFilters({ ...filters, establishment_id: e.target.value })}>
              <option value="">All establishments</option>
              {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </>
        )}
        <select
          value={canManage ? filters.month : pendingMonth}
          onChange={(e) => (canManage ? setFilters({ ...filters, month: e.target.value }) : setPendingMonth(e.target.value))}
        >
          <option value="">{canManage ? 'All months' : 'Select month'}</option>
          {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
        </select>
        <YearPicker
          value={canManage ? filters.year : pendingYear}
          onChange={(year) => (canManage ? setFilters({ ...filters, year }) : setPendingYear(year))}
          placeholder={canManage ? 'All years' : 'Select year'}
        />
        {!canManage && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!pendingMonth || !pendingYear}
            onClick={() => setFilters((f) => ({ ...f, month: pendingMonth, year: pendingYear }))}
          >
            Submit
          </button>
        )}
      </div>

      {noAccess && <div className="alert alert-error">Your account does not have access to salary slips.</div>}

      {!canManage && !periodReady ? (
        <div className="card muted" style={{ textAlign: 'center', padding: '32px 16px' }}>
          Select a month and year above to see the salary slip for that period.
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                {canDownload && (
                  <th style={{ width: 32 }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  </th>
                )}
                <th>Employee</th><th>Establishment</th><th>Period</th><th>Net pay</th><th>Uploaded</th>
                {!noAccess && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {slips.flatMap((s) => {
                const rows = [
                  <tr
                    key={s.id}
                    onClick={() => !noAccess && setPreviewSlip(s)}
                    className={previewSlip?.id === s.id ? 'row-selected' : ''}
                    style={{ cursor: noAccess ? 'default' : 'pointer' }}
                  >
                    {canDownload && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedIds.includes(s.id)} onChange={(e) => toggleOne(s.id, e)} />
                      </td>
                    )}
                    <td>{s.full_name} <span className="muted small">({s.emp_code})</span></td>
                    <td>{s.establishment_name}</td>
                    <td>{MONTHS[s.period_month]} {s.period_year}</td>
                    <td>{formatINR(s.net_pay)}</td>
                    <td>{new Date(s.uploaded_at).toLocaleDateString()}</td>
                    {!noAccess && (
                      <td>
                        <button className="link-btn" onClick={(e) => { e.stopPropagation(); setPreviewSlip(s); }}>Preview</button>
                        {canDownload && <button className="link-btn" onClick={(e) => download(s, e)}>Download</button>}
                      </td>
                    )}
                  </tr>
                ];
                if (previewSlip?.id === s.id) {
                  rows.push(
                    <tr key={`${s.id}-preview`}>
                      <td colSpan={canDownload ? 6 : 5} style={{ padding: 0 }}>
                        <div style={{ padding: 16, background: 'var(--bg)' }}>
                          <div className="page-header" style={{ marginBottom: 10 }}>
                            <h3 style={{ margin: 0 }}>
                              Preview — {previewSlip.full_name} ({previewSlip.emp_code}) — {MONTHS[previewSlip.period_month]} {previewSlip.period_year}
                            </h3>
                            <div style={{ display: 'flex', gap: 8 }}>
                              {canDownload && <button className="btn btn-outline btn-sm" onClick={(e) => download(previewSlip, e)}>Download</button>}
                              <button className="btn btn-outline btn-sm" onClick={() => setPreviewSlip(null)}>Close preview</button>
                            </div>
                          </div>
                          <iframe
                            key={previewSlip.id}
                            src={previewUrl}
                            title="Salary slip preview"
                            style={{ width: '100%', height: 640, border: '1px solid var(--border)', borderRadius: 6 }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                }
                return rows;
              })}
              {!slips.length && (
                <tr>
                  <td colSpan={canDownload ? 6 : 5} className="muted">
                    {searched || canManage ? 'No salary slips found for this selection.' : 'No salary slips generated yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}
