import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import ApproverPicker from '../components/ApproverPicker.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';

const MODULE_LABELS = { employees: 'Employee Master', upload_salary: 'Upload Salary Data', users: 'Users', establishments: 'Establishments' };
const ACTION_LABELS = {
  CREATE: 'Create', UPDATE: 'Edit', STATUS_CHANGE: 'Status Change', BULK_STATUS_CHANGE: 'Bulk Status Change', APP_ACCESS: 'App Access Change', BULK_APP_ACCESS: 'Bulk App Access Change',
  DELETE: 'Delete', BULK_DELETE: 'Bulk Delete', IMPORT: 'Bulk Import', BULK_UPDATE: 'Bulk Edit', BULK_DELETE_RECORDS: 'Delete Selected Records',
  ARREAR_CREATE: 'Arrear: Add', ARREAR_UPDATE: 'Arrear: Edit', ARREAR_IMPORT: 'Arrear: Bulk Import', ARREAR_DELETE: 'Arrear: Delete'
};
// The actions a rule can be made for. Each one also covers its "many at once"
// version: Edit covers Bulk Edit (and Bulk Role Change), Delete covers Bulk
// Delete and Delete Selected Records, Status Change covers Bulk Status Change,
// and a bulk Import is covered by Create / Edit.
const RULE_ACTIONS = ['CREATE', 'UPDATE', 'STATUS_CHANGE', 'DELETE'];
// Which of them are meaningful for a given module. Establishments only ever
// stages Edit and Delete; salary data has no status. Any module not listed
// here offers all four.
const MODULE_ACTIONS = {
  establishments: ['UPDATE', 'DELETE'],
  upload_salary: ['CREATE', 'UPDATE', 'DELETE']
};

// Which establishments an approver has access to, for display.
const scopeText = (u) => (u.all_establishments ? 'all establishments' : (u.establishments.join(', ') || 'no establishment yet'));

export default function ApprovalRouting() {
  const { showToast } = useToast();
  const [rules, setRules] = useState([]);
  const [eligible, setEligible] = useState([]);
  const [moduleKey, setModuleKey] = useState('');
  const [actions, setActions] = useState([]);
  const [approverIds, setApproverIds] = useState([]);
  const [editingIds, setEditingIds] = useState(null); // ids of the stored rules being edited

  // Rules that share a module and the same approvers are shown as one row,
  // with their actions comma separated.
  const grouped = (() => {
    const map = new Map();
    for (const r of rules) {
      const key = `${r.module_key || ''}|${r.approvers.map((a) => a.id).sort((x, y) => x - y).join(',')}`;
      if (!map.has(key)) map.set(key, { key, module_key: r.module_key, approvers: r.approvers, rules: [] });
      map.get(key).rules.push(r);
    }
    return [...map.values()];
  })();

  const load = () => {
    api.get('/api/approval-routing').then(({ data }) => setRules(data));
    api.get('/api/approval-routing/eligible-approvers').then(({ data }) => setEligible(data));
  };
  useEffect(load, []);

  // Only one module per rule — selecting one replaces whatever was
  // selected before, including "Any module". Switching modules also drops
  // any already-picked action that isn't actually offered for the newly
  // selected module, so a stale, hidden selection can't linger unseen.
  const selectModule = (key) => {
    setModuleKey(key);
    const allowed = MODULE_ACTIONS[key] || RULE_ACTIONS;
    setActions((prev) => prev.filter((a) => allowed.includes(a)));
  };

  const toggleAction = (value) => {
    setActions((prev) => prev.includes(value) ? prev.filter((x) => x !== value) : [...prev, value]);
  };
  const resetForm = () => { setModuleKey(''); setActions([]); setApproverIds([]); setEditingIds(null); };

  const startEdit = (g) => {
    setEditingIds(g.rules.map((r) => r.id));
    setModuleKey(g.module_key || '');
    setActions(g.rules.map((r) => r.action).filter(Boolean));
    setApproverIds(g.approvers.map((a) => a.id));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const availableActions = MODULE_ACTIONS[moduleKey] || RULE_ACTIONS;

  // One module, optionally several actions — one rule gets created per
  // selected action (all sharing the same module and the same approvers).
  // Leaving every action unselected means "any action" for that module,
  // same as before.
  const addRule = async (e) => {
    e.preventDefault();
    if (!moduleKey && !actions.length) {
      showToast('Pick a module, or at least an action — otherwise this would route everything', 'error');
      return;
    }
    if (!approverIds.length) {
      showToast('Select at least one approver', 'error');
      return;
    }
    const actionList = actions.length ? actions : [null];
    try {
      if (editingIds) {
        await api.put('/api/approval-routing/replace', {
          replace_ids: editingIds, module_key: moduleKey || null, actions, approver_ids: approverIds
        });
        showToast('Rule updated.');
        resetForm();
        load();
        return;
      }
      for (const action of actionList) {
        await api.post('/api/approval-routing', { module_key: moduleKey || null, action, approver_ids: approverIds });
      }
      showToast(actionList.length > 1 ? 'Rules added.' : 'Rule added.');
      resetForm();
      load();
    } catch (err) {
      showToast(err.response?.data?.message || 'Could not add rule', 'error');
      load();
    }
  };

  const removeGroup = async (g) => {
    if (!confirm('Delete this routing rule? Matching tasks will go back to being visible to the Super Admin only.')) return;
    for (const r of g.rules) await api.delete(`/api/approval-routing/${r.id}`);
    showToast('Rule deleted.');
    if (editingIds && g.rules.some((r) => editingIds.includes(r.id))) resetForm();
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
        <h3>{editingIds ? 'Edit rule' : 'Add a rule'}</h3>
        <form onSubmit={addRule} className="form-grid">
          <div className="span-2">
            <label>Module</label>
            <div className="chip-select">
              <button
                type="button"
                className={`chip${moduleKey === '' ? ' chip-selected' : ''}`}
                onClick={() => selectModule('')}
              >
                Any module
              </button>
              {Object.entries(MODULE_LABELS).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  className={`chip${moduleKey === key ? ' chip-selected' : ''}`}
                  onClick={() => selectModule(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="span-2">
            <label>Action(s) — leave none selected for "Any action"</label>
            <div className="chip-select">
              {availableActions.map((key) => (
                <button
                  type="button"
                  key={key}
                  className={`chip${actions.includes(key) ? ' chip-selected' : ''}`}
                  onClick={() => toggleAction(key)}
                >
                  {ACTION_LABELS[key]}
                </button>
              ))}
            </div>
          </div>
          <div className="span-2">
            <label>Approver(s)</label>
            <ApproverPicker
              options={eligible.map((u) => ({ id: u.id, label: u.user_id, detail: `${u.role_name} · ${scopeText(u)}` }))}
              value={approverIds}
              onChange={setApproverIds}
            />
          </div>
          <div className="span-2">
            <button className="btn btn-primary" disabled={!eligible.length}>{editingIds ? 'Update rule' : 'Add rule'}</button>
            {editingIds && <button type="button" className="btn btn-outline" style={{ marginLeft: 8 }} onClick={resetForm}>Cancel</button>}
          </div>
        </form>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Module</th><th>Action</th><th>Approver(s)</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {grouped.map((g) => (
              <tr key={g.key}>
                <td>{g.module_key ? (MODULE_LABELS[g.module_key] || g.module_key) : <span className="muted">Any</span>}</td>
                <td>{g.rules.map((r) => (r.action ? (ACTION_LABELS[r.action] || r.action) : 'Any')).join(', ')}</td>
                <td>{g.approvers.map((a) => a.user_id).join(', ')}</td>
                <td>
                  <button className="link-btn" onClick={() => startEdit(g)}>Edit</button>
                  <button className="link-btn danger" onClick={() => removeGroup(g)}>Delete</button>
                </td>
              </tr>
            ))}
            {!grouped.length && <tr><td colSpan={4} className="muted">No routing rules yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}
