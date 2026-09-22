import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';

const MODULE_LABELS = { employees: 'Employee Master', upload_salary: 'Upload Salary Data' };
const ACTION_LABELS = {
  CREATE: 'Create', UPDATE: 'Edit', STATUS_CHANGE: 'Status Change', BULK_STATUS_CHANGE: 'Bulk Status Change',
  DELETE: 'Delete', BULK_DELETE: 'Bulk Delete', IMPORT: 'Bulk Import'
};

export default function ApprovalRouting() {
  const { showToast } = useToast();
  const [rules, setRules] = useState([]);
  const [eligible, setEligible] = useState([]);
  const [moduleKey, setModuleKey] = useState('');
  const [action, setAction] = useState('');
  const [approverIds, setApproverIds] = useState([]);

  const load = () => {
    api.get('/api/approval-routing').then(({ data }) => setRules(data));
    api.get('/api/approval-routing/eligible-approvers').then(({ data }) => setEligible(data));
  };
  useEffect(load, []);

  const toggleApprover = (id) => {
    setApproverIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const addRule = async (e) => {
    e.preventDefault();
    if (!moduleKey && !action) {
      showToast('Pick at least a module or an action — otherwise this would route everything', 'error');
      return;
    }
    if (!approverIds.length) {
      showToast('Select at least one approver', 'error');
      return;
    }
    try {
      await api.post('/api/approval-routing', { module_key: moduleKey || null, action: action || null, approver_ids: approverIds });
      showToast('Rule added.');
      setModuleKey(''); setAction(''); setApproverIds([]);
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not add rule', 'error');
    }
  };

  const removeRule = async (rule) => {
    if (!confirm('Delete this routing rule? Matching tasks will go back to being visible to the Super Admin only.')) return;
    await api.delete(`/api/approval-routing/${rule.id}`);
    showToast('Rule deleted.');
    load();
  };

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Approval Routing</h1>
        </div>
      </div>

      <div className="card">
        <h3>Add a rule</h3>
        <form onSubmit={addRule} className="form-grid">
          <div>
            <label>Module</label>
            <select value={moduleKey} onChange={(e) => setModuleKey(e.target.value)}>
              <option value="">Any module</option>
              <option value="employees">Employee Master</option>
              <option value="upload_salary">Upload Salary Data</option>
            </select>
          </div>
          <div>
            <label>Action</label>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">Any action</option>
              {Object.entries(ACTION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </div>
          <div className="span-2">
            <label>Approver(s)</label>
            {!eligible.length && <p className="muted small">No accounts are eligible yet — turn on "Can approve" for an Admin account from the Users page first.</p>}
            <div className="chip-select">
              {eligible.map((u) => (
                <button
                  type="button"
                  key={u.id}
                  className={`chip${approverIds.includes(u.id) ? ' chip-selected' : ''}`}
                  onClick={() => toggleApprover(u.id)}
                >
                  {u.user_id}
                </button>
              ))}
            </div>
          </div>
          <div className="span-2">
            <button className="btn btn-primary" disabled={!eligible.length}>Add rule</button>
          </div>
        </form>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Module</th><th>Action</th><th>Approver(s)</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.module_key ? (MODULE_LABELS[r.module_key] || r.module_key) : <span className="muted">Any</span>}</td>
                <td>{r.action ? (ACTION_LABELS[r.action] || r.action) : <span className="muted">Any</span>}</td>
                <td>{r.approvers.map((a) => a.user_id).join(', ')}</td>
                <td><button className="link-btn danger" onClick={() => removeRule(r)}>Delete</button></td>
              </tr>
            ))}
            {!rules.length && <tr><td colSpan={4} className="muted">No routing rules yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}
