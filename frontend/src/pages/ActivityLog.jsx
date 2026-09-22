import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import api from '../api/axios.js';

const ACTION_LABELS = {
  LOGIN: 'Login',
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  IMPORT: 'Bulk Import',
  STATUS_CHANGE: 'Status Change',
  PASSWORD_RESET: 'Password Reset',
  PASSWORD_CHANGE: 'Password Change'
};

const EMPTY_FILTERS = { performed_by: '', role_name: '', action: '', module_key: '', from: '', to: '' };

export default function ActivityLog() {
  const [rows, setRows] = useState([]);
  const [modules, setModules] = useState([]);
  const [filterOptions, setFilterOptions] = useState({ performedBy: [], roleNames: [], actions: [] });
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const params = {};
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    api.get('/api/activity-log', { params }).then(({ data }) => setRows(data)).finally(() => setLoading(false));
  };

  useEffect(() => {
    api.get('/api/roles/modules').then(({ data }) => setModules(data));
    api.get('/api/activity-log/filters').then(({ data }) => setFilterOptions(data));
  }, []);

  useEffect(load, [filters]);

  const moduleLabel = (key) => modules.find((m) => m.key === key)?.label || key;
  const clearFilters = () => setFilters(EMPTY_FILTERS);
  const hasActiveFilters = Object.values(filters).some(Boolean);

  // Exports exactly what's currently filtered/displayed on screen — not
  // necessarily the whole log — same convention as Employee Master's
  // "Export to Excel" button. window.open can't set an Authorization
  // header, so the token travels as a query param instead; requireAuth
  // already accepts that as a fallback.
  const exportToExcel = () => {
    const token = localStorage.getItem('token');
    const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    params.set('token', token);
    window.open(`${base}/api/activity-log/export?${params.toString()}`, '_blank');
  };

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity Log</h1>
        </div>
        <button className="btn btn-outline" onClick={exportToExcel}>Export to Excel</button>
      </div>

      <div className="card">
        <div className="filter-bar">
          <select value={filters.performed_by} onChange={(e) => setFilters({ ...filters, performed_by: e.target.value })}>
            <option value="">All staff members</option>
            {filterOptions.performedBy.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <select value={filters.role_name} onChange={(e) => setFilters({ ...filters, role_name: e.target.value })}>
            <option value="">All roles</option>
            {filterOptions.roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
            <option value="">All actions</option>
            {filterOptions.actions.map((a) => <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>)}
          </select>
          <select value={filters.module_key} onChange={(e) => setFilters({ ...filters, module_key: e.target.value })}>
            <option value="">All modules</option>
            {modules.filter((m) => m.key !== 'activity_log').map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <span className="date-field-group">
            <span className="date-field-label">From</span>
            <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </span>
          <span className="date-field-group">
            <span className="date-field-label">To</span>
            <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </span>
          {hasActiveFilters && (
            <button type="button" className="btn btn-outline" onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Date &amp; time</th><th>Staff member</th><th>Role</th><th>Action</th><th>Module</th><th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.performed_by}</td>
                <td>{r.role_name}</td>
                <td>{ACTION_LABELS[r.action] || r.action}</td>
                <td>{r.module_key ? moduleLabel(r.module_key) : '-'}</td>
                <td>{r.description}</td>
              </tr>
            ))}
            {!loading && !rows.length && (
              <tr><td colSpan={6} className="muted">{hasActiveFilters ? 'No activity found for this selection.' : 'No activity recorded yet.'}</td></tr>
            )}
          </tbody>
        </table>
        {rows.length === 1000 && (
          <div className="muted small" style={{ padding: '8px 4px' }}>
            Showing the 1000 most recent matching entries. Narrow the filters above to see older activity.
          </div>
        )}
      </div>
    </Layout>
  );
}
