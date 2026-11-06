import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import SearchAutocomplete from '../components/SearchAutocomplete.jsx';
import ChangeDetails from '../components/ChangeDetails.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';
import { API_BASE } from '../config/apiBase.js';

const MODULE_LABELS = { employees: 'Employee Master', users: 'Users', upload_salary: 'Upload Salary Data', establishments: 'Establishments' };
const ACTION_LABELS = {
  CREATE: 'Create', UPDATE: 'Edit', STATUS_CHANGE: 'Status Change', BULK_STATUS_CHANGE: 'Bulk Status Change', APP_ACCESS: 'App Access Change', BULK_APP_ACCESS: 'Bulk App Access Change',
  BULK_ROLE_CHANGE: 'Bulk Role Change', DELETE: 'Delete', BULK_DELETE: 'Bulk Delete', IMPORT: 'Bulk Import', BULK_UPDATE: 'Bulk Edit', BULK_DELETE_RECORDS: 'Delete Selected Records',
  ARREAR_CREATE: 'Arrear: Add', ARREAR_UPDATE: 'Arrear: Edit', ARREAR_IMPORT: 'Arrear: Bulk Import', ARREAR_DELETE: 'Arrear: Delete'
};

const shorten = (text, n = 60) => (text && text.length > n ? `${text.slice(0, n)}...` : text);

// One request, in full: who asked, why, and exactly what will change.
function RequestCard({ item, open, onDownload, selectable, picked, onToggle, onToggleAll }) {
  return (
    <details open={open} style={{ border: '1px solid var(--border)', borderRadius: 6, marginBottom: 10, background: 'var(--bg)' }}>
      <summary style={{ padding: '10px 12px', cursor: 'pointer' }}>
        <strong>{item.description}</strong>{' '}
        <span className="muted small">
          — {MODULE_LABELS[item.module_key] || item.module_key} / {ACTION_LABELS[item.action] || item.action}
          {' '}— by {item.requested_by_name}, {new Date(item.created_at).toLocaleString()}
        </span>
      </summary>
      <div style={{ padding: '0 12px 12px' }}>
        <div style={{ margin: '4px 0 10px', padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6 }}>
          <div className="muted small">Remarks from {item.requested_by_name}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{item.request_reason || 'No remarks were given (request made before remarks were required).'}</div>
        </div>
        {item.status !== 'PENDING' && (
          <p className="small">
            <strong>{item.status}</strong>
            {item.decided_by_name ? ` by ${item.decided_by_name}` : ''}
            {item.decided_at ? ` on ${new Date(item.decided_at).toLocaleString()}` : ''}
            {item.rejection_reason ? ` — ${item.rejection_reason}` : ''}
          </p>
        )}
        <ChangeDetails details={item.change_details} selectable={selectable} picked={picked} onToggle={onToggle} onToggleAll={onToggleAll} />
        {item.has_file && (
          <p><button type="button" className="link-btn" onClick={() => onDownload(item)}>Download the uploaded Excel file to review</button></p>
        )}
      </div>
    </details>
  );
}

export default function Approvals() {
  const { showToast } = useToast();
  const [status, setStatus] = useState('PENDING');
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);

  // review: { mode: 'view' | 'approve' | 'reject', items: [full request details] }
  const [review, setReview] = useState(null);
  const [loadingReview, setLoadingReview] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState([]);
  // Deciding only some records of one request: which are ticked, and whether
  // the approver is in the middle of rejecting them (needs a reason).
  const [picked, setPicked] = useState([]);
  const [partMode, setPartMode] = useState(null); // null | 'reject'

  const load = () => {
    api.get('/api/approvals', { params: { status } })
      .then(({ data }) => { setRows(data); setSelected([]); })
      .catch((err) => {
        console.error('Failed to load approvals:', err.response?.status, err.response?.data);
        showToast(err.response?.data?.message || `Could not load approvals (status ${err.response?.status || 'unknown'})`, 'error');
      });
  };
  useEffect(load, [status]);

  const isPending = status === 'PENDING';
  const needle = search.trim().toLowerCase();
  const shownRows = needle ? rows.filter((r) => (r.requested_by_name || '').toLowerCase().includes(needle)) : rows;
  const requesters = [...new Set(rows.map((r) => r.requested_by_name).filter(Boolean))].map((n) => ({ name: n }));
  const allSelected = shownRows.length > 0 && shownRows.every((r) => selected.includes(r.id));
  const toggleOne = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleAll = () => setSelected((prev) => {
    const ids = shownRows.map((r) => r.id);
    return allSelected ? prev.filter((id) => !ids.includes(id)) : [...new Set([...prev, ...ids])];
  });

  // Opens the review window for one or several requests, with each one's
  // reason and full change details loaded, so nothing is decided blind.
  const openReview = async (ids, mode) => {
    setLoadingReview(true);
    try {
      const items = await Promise.all(ids.map((id) => api.get(`/api/approvals/${id}`).then(({ data }) => data)));
      setReason('');
      setFailures([]);
      setPicked([]);
      setPartMode(null);
      setReview({ mode, items });
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not load the request details', 'error');
    } finally {
      setLoadingReview(false);
    }
  };

  const closeReview = () => { setReview(null); setReason(''); setFailures([]); setPicked([]); setPartMode(null); };

  const togglePick = (id) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleAllPicks = (ids) => setPicked((prev) => (ids.every((id) => prev.includes(id)) ? [] : ids));

  // Approve or reject only the ticked records of the one request on screen.
  const decideSome = async (decision) => {
    const item = review.items[0];
    if (!picked.length) return;
    if (decision === 'reject' && !reason.trim()) return;
    if (decision === 'approve' && !confirm(`Approve the ${picked.length} selected record(s)? The rest will stay pending.`)) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/api/approvals/${item.id}/decide-some`, { decision, ids: picked, reason });
      showToast(data.message);
      load();
      if (data.remaining > 0) await openReview([item.id], 'view');
      else closeReview();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not complete this decision', 'error');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (mode) => {
    if (mode === 'reject' && !reason.trim()) return;
    const ids = review.items.map((i) => i.id);
    setBusy(true);
    try {
      const { data } = mode === 'approve'
        ? await api.post('/api/approvals/bulk-approve', { ids })
        : await api.post('/api/approvals/bulk-reject', { ids, reason });
      const failed = data.results.filter((r) => !r.ok);
      if (!failed.length) {
        showToast(data.message);
        closeReview();
      } else {
        // Keep only the requests that did not go through, with the reason,
        // so they can be retried or dealt with differently.
        showToast(data.message, 'error');
        setFailures(failed.map((f) => ({ id: f.id, message: f.message })));
        setReview((prev) => ({ ...prev, mode, items: prev.items.filter((i) => failed.some((f) => f.id === i.id)) }));
      }
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not complete this decision', 'error');
    } finally {
      setBusy(false);
    }
  };

  const downloadFile = (row) => {
    const token = localStorage.getItem('token');
    window.open(`${API_BASE}/api/approvals/${row.id}/file?token=${token}`, '_blank');
  };

  const n = review?.items.length || 0;
  // One pending request that lists several records: they can be decided one by one.
  const canPickSome = !!review && review.items.length === 1 && !!review.items[0].splittable && review.mode === 'view';
  const modalTitle = !review ? '' : review.mode === 'approve' ? `Approve ${n} request(s)` : review.mode === 'reject' ? `Reject ${n} request(s)` : n === 1 ? 'Request details' : `${n} request(s)`;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Approvals</h1>
        </div>
      </div>

      <div className="filter-bar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="EXPIRED">Expired</option>
        </select>
        <SearchAutocomplete
          placeholder="Requested by"
          value={search}
          onChange={setSearch}
          options={requesters}
          getLabel={(o) => o.name}
          getValue={(o) => o.name}
          getKey={(o) => o.name}
        />
      </div>

      <div className="card">
        {isPending && selected.length > 0 && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <span>{selected.length} selected</span>
            <button className="btn btn-primary btn-sm" disabled={loadingReview} onClick={() => openReview(selected, 'approve')}>Review &amp; approve</button>
            <button className="btn btn-outline btn-sm btn-danger-outline" disabled={loadingReview} onClick={() => openReview(selected, 'reject')}>Review &amp; reject</button>
            <button className="btn btn-outline btn-sm" onClick={() => setSelected([])}>Clear selection</button>
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              {isPending && <th style={{ width: 32 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>}
              <th>Requested by</th><th>Module</th><th>Action</th><th>Description</th><th>Remarks</th>
              <th>Requested on</th>
              {isPending && <th>Expires</th>}
              {!isPending && <th>Decided by</th>}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {shownRows.map((r) => (
              <tr key={r.id}>
                {isPending && <td><input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggleOne(r.id)} /></td>}
                <td>{r.requested_by_name}</td>
                <td>{MODULE_LABELS[r.module_key] || r.module_key}</td>
                <td>{ACTION_LABELS[r.action] || r.action}</td>
                <td>{r.description}</td>
                <td title={r.request_reason || ''}>{shorten(r.request_reason) || <span className="muted">—</span>}</td>
                <td className="nowrap">{new Date(r.created_at).toLocaleString()}</td>
                {isPending && <td className="nowrap">{new Date(r.expires_at).toLocaleDateString()}</td>}
                {!isPending && <td>{r.decided_by_name || '-'}</td>}
                <td className="nowrap">
                  <button className="link-btn" disabled={loadingReview} onClick={() => openReview([r.id], 'view')}>View</button>
                  {isPending && (
                    <>
                      <button className="link-btn" disabled={loadingReview} onClick={() => openReview([r.id], 'approve')}>Approve</button>
                      <button className="link-btn danger" disabled={loadingReview} onClick={() => openReview([r.id], 'reject')}>Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!shownRows.length && <tr><td colSpan={isPending ? 9 : 8} className="muted">{search ? 'No matching requests.' : <>No {status.toLowerCase()} requests.</>}</td></tr>}
          </tbody>
        </table>
      </div>

      {review && (
        <Modal title={modalTitle} onClose={closeReview} width={920}>
          {failures.length > 0 && (
            <div className="alert alert-error" style={{ marginBottom: 12 }}>
              <strong>These could not be completed and are still pending:</strong>
              <ul style={{ margin: '6px 0 0 18px' }}>
                {failures.map((f) => <li key={f.id}>Request #{f.id}: {f.message}</li>)}
              </ul>
            </div>
          )}

          {review.items.map((item) => (
            <RequestCard
              key={item.id}
              item={item}
              open={review.items.length <= 5}
              onDownload={downloadFile}
              selectable={canPickSome}
              picked={picked}
              onToggle={togglePick}
              onToggleAll={toggleAllPicks}
            />
          ))}

          {canPickSome && (
            <div style={{ marginTop: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{picked.length} of {review.items[0].change_details?.entries?.filter((e) => e.itemId != null).length || 0} selected</strong>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !picked.length} onClick={() => decideSome('approve')}>
                  Approve selected ({picked.length})
                </button>
                <button type="button" className="btn btn-outline btn-sm btn-danger-outline" disabled={busy || !picked.length} onClick={() => setPartMode('reject')}>
                  Reject selected ({picked.length})
                </button>
              </div>
              {partMode === 'reject' && (
                <div style={{ marginTop: 10 }}>
                  <label>Reason for rejecting the {picked.length} selected record(s) (shown to {review.items[0].requested_by_name})</label>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} style={{ width: '100%' }} />
                  <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={busy || !picked.length || !reason.trim()} onClick={() => decideSome('reject')}>
                    {busy ? 'Rejecting...' : `Reject ${picked.length} selected`}
                  </button>
                </div>
              )}
            </div>
          )}

          {review.mode === 'reject' && (
            <div style={{ marginTop: 12 }}>
              <label>
                Reason for rejection (shown to {n === 1 ? review.items[0].requested_by_name : 'the requesters'})
              </label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required style={{ width: '100%' }} />
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={closeReview}>{review.mode === 'view' ? 'Close' : 'Cancel'}</button>
            {review.mode === 'view' && review.items.every((i) => i.status === 'PENDING') && (
              <>
                <button type="button" className="btn btn-outline" onClick={() => setReview({ ...review, mode: 'reject' })}>{canPickSome ? 'Reject all' : 'Reject'}</button>
                <button type="button" className="btn btn-primary" onClick={() => setReview({ ...review, mode: 'approve' })}>{canPickSome ? 'Approve all' : 'Approve'}</button>
              </>
            )}
            {review.mode === 'approve' && (
              <button type="button" className="btn btn-primary" disabled={busy || !n} onClick={() => decide('approve')}>
                {busy ? 'Approving...' : `Approve ${n > 1 ? `all ${n}` : ''}`.trim()}
              </button>
            )}
            {review.mode === 'reject' && (
              <button type="button" className="btn btn-primary" disabled={busy || !n || !reason.trim()} onClick={() => decide('reject')}>
                {busy ? 'Rejecting...' : `Reject ${n > 1 ? `all ${n}` : ''}`.trim()}
              </button>
            )}
          </div>
        </Modal>
      )}
    </Layout>
  );
}
