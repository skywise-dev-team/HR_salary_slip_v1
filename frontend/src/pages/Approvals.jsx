import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';

const MODULE_LABELS = { employees: 'Employee Master', users: 'Users', upload_salary: 'Upload Salary Data' };
const ACTION_LABELS = {
  CREATE: 'Create', UPDATE: 'Edit', STATUS_CHANGE: 'Status Change', BULK_STATUS_CHANGE: 'Bulk Status Change',
  BULK_ROLE_CHANGE: 'Bulk Role Change', DELETE: 'Delete', BULK_DELETE: 'Bulk Delete', IMPORT: 'Bulk Import'
};

export default function Approvals() {
  const { showToast } = useToast();
  const [status, setStatus] = useState('PENDING');
  const [rows, setRows] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const load = () => {
    api.get('/api/approvals', { params: { status } })
      .then(({ data }) => setRows(data))
      .catch((err) => {
        console.error('Failed to load approvals:', err.response?.status, err.response?.data);
        showToast(err.response?.data?.message || `Could not load approvals (status ${err.response?.status || 'unknown'})`, 'error');
      });
  };
  useEffect(load, [status]);

  const approve = async (row) => {
    if (!confirm(`Approve "${row.description}"? This will apply the change immediately.`)) return;
    try {
      const { data } = await api.post(`/api/approvals/${row.id}/approve`);
      showToast(data.message || 'Approved and applied.');
      setViewing(null);
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not approve this request', 'error');
    }
  };

  const submitReject = async (e) => {
    e.preventDefault();
    if (!reason.trim()) return;
    try {
      const { data } = await api.post(`/api/approvals/${rejecting.id}/reject`, { reason });
      showToast(data.message || 'Rejected.');
      setRejecting(null);
      setReason('');
      setViewing(null);
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not reject this request', 'error');
    }
  };

  const downloadFile = (row) => {
    const token = localStorage.getItem('token');
    const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
    window.open(`${base}/api/approvals/${row.id}/file?token=${token}`, '_blank');
  };

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
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Requested by</th><th>Module</th><th>Action</th><th>Description</th>
              <th>Requested on</th>
              {status === 'PENDING' && <th>Expires</th>}
              {status !== 'PENDING' && <th>Decided by</th>}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.requested_by_name}</td>
                <td>{MODULE_LABELS[r.module_key] || r.module_key}</td>
                <td>{ACTION_LABELS[r.action] || r.action}</td>
                <td>{r.description}</td>
                <td className="nowrap">{new Date(r.created_at).toLocaleString()}</td>
                {status === 'PENDING' && <td className="nowrap">{new Date(r.expires_at).toLocaleDateString()}</td>}
                {status !== 'PENDING' && <td>{r.decided_by_name || '-'}</td>}
                <td className="nowrap">
                  <button className="link-btn" onClick={() => setViewing(r)}>View</button>
                  {status === 'PENDING' && (
                    <>
                      <button className="link-btn" onClick={() => approve(r)}>Approve</button>
                      <button className="link-btn danger" onClick={() => setRejecting(r)}>Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">No {status.toLowerCase()} requests.</td></tr>}
          </tbody>
        </table>
      </div>

      {viewing && (
        <Modal title="Request details" onClose={() => setViewing(null)}>
          <div className="detail-list">
            <div><span>Requested by</span><span>{viewing.requested_by_name}</span></div>
            <div><span>Module</span><span>{MODULE_LABELS[viewing.module_key] || viewing.module_key}</span></div>
            <div><span>Action</span><span>{ACTION_LABELS[viewing.action] || viewing.action}</span></div>
            <div><span>Description</span><span>{viewing.description}</span></div>
            <div><span>Requested on</span><span>{new Date(viewing.created_at).toLocaleString()}</span></div>
            {viewing.status === 'PENDING' && <div><span>Expires</span><span>{new Date(viewing.expires_at).toLocaleString()}</span></div>}
            {viewing.status !== 'PENDING' && (
              <>
                <div><span>Status</span><span>{viewing.status}</span></div>
                <div><span>Decided by</span><span>{viewing.decided_by_name || '-'}</span></div>
                <div><span>Decided on</span><span>{viewing.decided_at ? new Date(viewing.decided_at).toLocaleString() : '-'}</span></div>
                {viewing.rejection_reason && <div><span>Reason</span><span>{viewing.rejection_reason}</span></div>}
              </>
            )}
            {viewing.payload && (
              <div><span>Submitted data</span>
                <pre className="payload-preview">{JSON.stringify(typeof viewing.payload === 'string' ? JSON.parse(viewing.payload) : viewing.payload, null, 2)}</pre>
              </div>
            )}
            {viewing.has_file && (
              <div><span>File</span><span><button className="link-btn" onClick={() => downloadFile(viewing)}>Download to review</button></span></div>
            )}
          </div>
          {viewing.status === 'PENDING' && (
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setRejecting(viewing)}>Reject</button>
              <button className="btn btn-primary" onClick={() => approve(viewing)}>Approve</button>
            </div>
          )}
        </Modal>
      )}

      {rejecting && (
        <Modal title={`Reject — ${rejecting.description}`} onClose={() => { setRejecting(null); setReason(''); }}>
          <form onSubmit={submitReject}>
            <label>Reason (shown to {rejecting.requested_by_name})</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} required style={{ width: '100%' }} />
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => { setRejecting(null); setReason(''); }}>Cancel</button>
              <button type="submit" className="btn btn-primary">Reject request</button>
            </div>
          </form>
        </Modal>
      )}
    </Layout>
  );
}
