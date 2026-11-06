import { useEffect, useState } from 'react';
import YearPicker from './YearPicker.jsx';
import Pagination from './Pagination.jsx';
import api from '../api/axios.js';
import { formatINR } from '../utils/formatCurrency.js';
import { API_BASE } from '../config/apiBase.js';

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const PAGE_SIZE_OPTIONS = [50, 100, 150, 200];

const periodText = (s) => `${MONTHS[s.arrear_from_month]}-${s.arrear_from_year} to ${MONTHS[s.arrear_to_month]}-${s.arrear_to_year}`;

// The "Arrear slips" tab of the Salary Slips page. Works exactly like the
// monthly slips: the list comes from the arrear records, and a slip is only
// generated at the moment someone previews or downloads it — nothing is ever
// stored on the server.
//   canManage   - may search / filter by establishment
//   canDownload - may download (otherwise preview only)
//   noAccess    - account has no access to salary slips at all
export default function ArrearSlips({ canManage, canDownload, noAccess }) {
  const [slips, setSlips] = useState([]);
  const [establishments, setEstablishments] = useState([]);
  const [filters, setFilters] = useState({ establishment_id: '', month: '', year: '', search: '' });
  const [previewSlip, setPreviewSlip] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [estPages, setEstPages] = useState({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  useEffect(() => {
    if (canManage) api.get('/api/establishments/lookup').then(({ data }) => setEstablishments(data)).catch(() => {});
  }, [canManage]);

  useEffect(() => {
    const params = {};
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    api.get('/api/salary-slips/arrear', { params }).then(({ data }) => setSlips(data)).catch(() => setSlips([]));
    setPreviewSlip(null);
    setPage(1);
    setEstPages({});
  }, [filters]);

  const token = localStorage.getItem('token');

  const download = (slip, e) => {
    e?.stopPropagation();
    window.open(`${API_BASE}/api/salary-slips/arrear/${slip.id}/download?token=${token}`, '_blank');
  };

  const downloadZip = (ids) => {
    const params = new URLSearchParams();
    if (ids) params.set('ids', ids.join(','));
    else Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    params.set('token', token);
    window.open(`${API_BASE}/api/salary-slips/arrear-bulk-download?${params.toString()}`, '_blank');
  };

  const toggleOne = (id, e) => {
    e.stopPropagation();
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };
  const allSelected = slips.length > 0 && slips.every((s) => selectedIds.includes(s.id));
  const toggleAll = () => setSelectedIds((ids) => {
    const shown = slips.map((s) => s.id);
    return allSelected ? ids.filter((id) => !shown.includes(id)) : [...new Set([...ids, ...shown])];
  });
  // With "All establishments" and "All from months" the list is grouped:
  // establishment -> employee -> that employee's arrear slips (latest first).
  const grouped = canManage && !filters.establishment_id && !filters.month;
  const orderedSlips = grouped
    ? [...slips].sort((a, b) =>
      String(a.establishment_name || '').localeCompare(String(b.establishment_name || ''))
      || String(a.full_name || '').localeCompare(String(b.full_name || ''))
      || String(a.emp_code || '').localeCompare(String(b.emp_code || ''))
      || (b.arrear_from_year - a.arrear_from_year) || (b.arrear_from_month - a.arrear_from_month)
      || (b.arrear_to_year - a.arrear_to_year) || (b.arrear_to_month - a.arrear_to_month))
    : slips;
  const pagedSlips = orderedSlips.slice((page - 1) * pageSize, page * pageSize);
  const toggleCollapse = (key) => setExpanded((c) => ({ ...c, [key]: !c[key] }));
  const groupIds = (pred) => slips.filter(pred).map((x) => x.id);
  const toggleGroup = (ids) => setSelectedIds((cur) => (ids.every((id) => cur.includes(id)) ? cur.filter((id) => !ids.includes(id)) : [...new Set([...cur, ...ids])]));
  const pagedItems = [];
  if (grouped) {
    // Every establishment is listed on the page; each one is paginated on its own.
    const byEst = [];
    orderedSlips.forEach((sl) => {
      const last = byEst[byEst.length - 1];
      if (last && last.name === sl.establishment_name) last.slips.push(sl);
      else byEst.push({ name: sl.establishment_name, slips: [sl] });
    });
    byEst.forEach((g) => {
      const estKey = `e:${g.name}`;
      pagedItems.push({ type: 'est', key: estKey, name: g.name });
      if (!expanded[estKey]) return;
      const totalPages = Math.max(1, Math.ceil(g.slips.length / pageSize));
      const ePage = Math.min(estPages[estKey] || 1, totalPages);
      let lastEmp = null;
      g.slips.slice((ePage - 1) * pageSize, ePage * pageSize).forEach((sl) => {
        const empKey = `${estKey}|m:${sl.emp_code}`;
        if (empKey !== lastEmp) { pagedItems.push({ type: 'emp', key: empKey, estName: sl.establishment_name, slip: sl }); lastEmp = empKey; }
        if (!expanded[empKey]) return;
        pagedItems.push({ type: 'slip', slip: sl });
      });
      if (g.slips.length > pageSize) pagedItems.push({ type: 'pager', key: `${estKey}|pager`, estKey, page: ePage, total: g.slips.length });
    });
  } else {
    pagedSlips.forEach((sl) => pagedItems.push({ type: 'slip', slip: sl }));
  }
  const cols = canDownload ? 7 : 6;

  const previewUrl = previewSlip
    ? `${API_BASE}/api/salary-slips/arrear/${previewSlip.id}/preview?token=${token}#toolbar=0&navpanes=0`
    : null;

  return (
    <>
      {canDownload && slips.length > 0 && (
        <div style={{ marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={() => downloadZip(null)}>
            Download all as ZIP ({slips.length}) — grouped by establishment
          </button>
          {selectedIds.length > 0 && (
            <button className="btn btn-primary" onClick={() => downloadZip(selectedIds)}>
              Download selected as ZIP ({selectedIds.length})
            </button>
          )}
        </div>
      )}

      <div className="filter-bar">
        {canManage && (
          <>
            <input
              placeholder="Employee name or ID"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            />
            <select value={filters.establishment_id} onChange={(e) => setFilters({ ...filters, establishment_id: e.target.value })}>
              <option value="">All establishments</option>
              {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </>
        )}
        <select value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value })}>
          <option value="">All "from" months</option>
          {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
        </select>
        <YearPicker
          value={filters.year}
          onChange={(year) => setFilters({ ...filters, year })}
          placeholder="All years"
        />
      </div>

      {noAccess && <div className="alert alert-error">Your account does not have access to salary slips.</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              {canDownload && (
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                </th>
              )}
              <th>Employee</th><th>Establishment</th><th>Arrear period</th><th>Date of issue</th><th>Net pay</th>
              {!noAccess && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pagedItems.flatMap((it) => {
              const span = canDownload ? 6 : 5;
              if (it.type === 'est') {
                const ids = groupIds((x) => x.establishment_name === it.name);
                const emps = new Set(slips.filter((x) => x.establishment_name === it.name).map((x) => x.emp_code)).size;
                return [(
                  <tr key={it.key} onClick={() => toggleCollapse(it.key)} style={{ cursor: 'pointer', background: '#e8f1ec' }}>
                    {canDownload && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={ids.length > 0 && ids.every((id) => selectedIds.includes(id))} ref={(el) => { if (el) el.indeterminate = ids.some((id) => selectedIds.includes(id)) && !ids.every((id) => selectedIds.includes(id)); }} onChange={() => toggleGroup(ids)} /></td>}
                    <td colSpan={span - (canDownload ? 1 : 0)}>
                      <strong>{!expanded[it.key] ? '▸' : '▾'} {it.name}</strong>
                      <span className="muted small"> — {emps} employee(s), {ids.length} slip(s)</span>
                    </td>
                  </tr>
                )];
              }
              if (it.type === 'pager') {
                return [(
                  <tr key={it.key}>
                    <td colSpan={span} style={{ padding: 0 }}>
                      <Pagination page={it.page} setPage={(n) => setEstPages((m) => ({ ...m, [it.estKey]: n }))} pageSize={pageSize} setPageSize={(n) => { setPageSize(n); setEstPages({}); }} totalItems={it.total} pageSizeOptions={PAGE_SIZE_OPTIONS} />
                    </td>
                  </tr>
                )];
              }
              if (it.type === 'emp') {
                const sl = it.slip;
                const ids = groupIds((x) => x.establishment_name === it.estName && x.emp_code === sl.emp_code);
                return [(
                  <tr key={it.key} onClick={() => toggleCollapse(it.key)} style={{ cursor: 'pointer', background: '#f6f8f7' }}>
                    {canDownload && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={ids.length > 0 && ids.every((id) => selectedIds.includes(id))} ref={(el) => { if (el) el.indeterminate = ids.some((id) => selectedIds.includes(id)) && !ids.every((id) => selectedIds.includes(id)); }} onChange={() => toggleGroup(ids)} /></td>}
                    <td colSpan={span - (canDownload ? 1 : 0)} style={{ paddingLeft: 28 }}>
                      <strong>{!expanded[it.key] ? '▸' : '▾'} {sl.full_name}</strong> <span className="muted small">({sl.emp_code}) — {ids.length} slip(s)</span>
                    </td>
                  </tr>
                )];
              }
              const s = it.slip;
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
                  <td style={grouped ? { paddingLeft: 52 } : undefined}>{s.full_name} <span className="muted small">({s.emp_code})</span></td>
                  <td>{s.establishment_name}</td>
                  <td className="nowrap">{periodText(s)}</td>
                  <td>{s.date_of_issue_text || '—'}</td>
                  <td>{formatINR(s.net_pay)}</td>
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
                    <td colSpan={cols} style={{ padding: 0 }}>
                      <div style={{ padding: 16, background: 'var(--bg)' }}>
                        <div className="page-header" style={{ marginBottom: 10 }}>
                          <h3 style={{ margin: 0 }}>
                            Preview — {previewSlip.full_name} ({previewSlip.emp_code}) — Arrear {periodText(previewSlip)}
                          </h3>
                          <div style={{ display: 'flex', gap: 8 }}>
                            {canDownload && <button className="btn btn-outline btn-sm" onClick={(e) => download(previewSlip, e)}>Download</button>}
                            <button className="btn btn-outline btn-sm" onClick={() => setPreviewSlip(null)}>Close preview</button>
                          </div>
                        </div>
                        <iframe
                          key={previewSlip.id}
                          src={previewUrl}
                          title="Arrear salary slip preview"
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
                <td colSpan={cols} className="muted">No arrear slips found for this selection.</td>
              </tr>
            )}
          </tbody>
        </table>
        {!grouped && <Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalItems={slips.length} pageSizeOptions={PAGE_SIZE_OPTIONS} />}
      </div>
    </>
  );
}
