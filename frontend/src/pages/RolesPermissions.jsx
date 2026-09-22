import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';

// Modules with nothing on them to edit or delete — View is the only
// permission that's ever meaningful for these.
const VIEW_ONLY_MODULES = ['dashboard', 'activity_log'];

export default function RolesPermissions() {
  const [roles, setRoles] = useState([]);
  const [modules, setModules] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ role_name: '', description: '', modules: [] });
  const [error, setError] = useState('');
  const [accessRole, setAccessRole] = useState(null);
  const [matrix, setMatrix] = useState([]);
  const [viewing, setViewing] = useState(null);
  const { showToast } = useToast();

  const load = () => api.get('/api/roles').then(({ data }) => setRoles(data));
  useEffect(() => { load(); api.get('/api/roles/modules').then(({ data }) => setModules(data)); }, []);

  const openAdd = () => { setEditing(null); setForm({ role_name: '', description: '', modules: [] }); setError(''); setModalOpen(true); };
  const openEdit = (role) => { setEditing(role); setForm({ role_name: role.role_name, description: role.description || '', modules: role.modules }); setError(''); setModalOpen(true); };

  const toggleModule = (key) => {
    setForm((f) => ({
      ...f,
      modules: f.modules.includes(key) ? f.modules.filter((m) => m !== key) : [...f.modules, key]
    }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) await api.put(`/api/roles/${editing.id}`, form);
      else await api.post('/api/roles', form);
      setModalOpen(false);
      showToast(editing ? 'Role updated successfully!' : 'Role added successfully!');
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    }
  };

  const remove = async (role) => {
    if (!confirm(`Delete role "${role.role_name}"?`)) return;
    await api.delete(`/api/roles/${role.id}`);
    showToast('Role deleted.');
    load();
  };

  const openManageAccess = async (role) => {
    const { data } = await api.get(`/api/roles/${role.id}`);
    const rows = data.modules.map((key) => {
      const existing = data.permissions.find((p) => p.module_key === key) || {};
      const mod = modules.find((m) => m.key === key);
      return {
        module_key: key,
        label: mod?.label || key,
        can_view: !!existing.can_view,
        // Dashboard and Activity Log are both read-only — there's nothing
        // on either to edit or delete, so those are never meaningful for
        // these modules regardless of what might already be stored.
        can_edit: VIEW_ONLY_MODULES.includes(key) ? false : !!existing.can_edit,
        can_delete: VIEW_ONLY_MODULES.includes(key) ? false : !!existing.can_delete
      };
    });
    setMatrix(rows);
    setAccessRole(role);
  };

  const flip = (idx, field) => {
    setMatrix((m) => m.map((row, i) => (i === idx ? { ...row, [field]: !row[field] } : row)));
  };

  const saveMatrix = async () => {
    await api.put(`/api/roles/${accessRole.id}/permissions`, { permissions: matrix });
    setAccessRole(null);
    showToast('Permissions saved successfully!');
    load();
  };

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Roles & Permissions</h1>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>Add role</button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Title</th><th>Description</th><th>Manage Access</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td>{r.role_name}</td>
                <td>{r.description || '-'}</td>
                <td><button className="btn btn-primary btn-sm" onClick={() => openManageAccess(r)}>Manage Access</button></td>
                <td>
                  <button className="link-btn" onClick={() => openEdit(r)}>Edit</button>
                  <button className="link-btn" onClick={() => setViewing(r)}>View</button>
                  <button className="link-btn danger" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
            {!roles.length && <tr><td colSpan={4} className="muted">No roles yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <Modal title={editing ? 'Edit role' : 'Add role'} onClose={() => setModalOpen(false)}>
          <form onSubmit={submit} className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            {error && <div className="alert alert-error">{error}</div>}

            <div>
              <label>Title</label>
              <input value={form.role_name} onChange={(e) => setForm({ ...form, role_name: e.target.value })} placeholder="Role title" required />
            </div>
            <div>
              <label>Description</label>
              <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div>
              <label>Select modules</label>
              <small className="hint">Selected modules get View access by default — grant Edit/Delete afterwards via Manage Access.</small>
              <div className="chip-select" style={{ marginTop: 6 }}>
                {modules.map((m) => (
                  <button
                    type="button"
                    key={m.key}
                    className={`chip${form.modules.includes(m.key) ? ' chip-selected' : ''}`}
                    onClick={() => toggleModule(m.key)}
                  >
                    {m.label} {form.modules.includes(m.key) ? '\u00d7' : ''}
                  </button>
                ))}
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="btn btn-primary">{editing ? 'Save changes' : 'Submit'}</button>
            </div>
          </form>
        </Modal>
      )}

      {accessRole && (
        <Modal title={`Manage Access — ${accessRole.role_name}`} onClose={() => setAccessRole(null)} width={720}>
          <table className="table">
            <thead>
              <tr><th>Name</th><th>View</th><th>Edit</th><th>Delete</th></tr>
            </thead>
            <tbody>
              {matrix.map((row, idx) => (
                <tr key={row.module_key}>
                  <td>{row.label}</td>
                  <td><input type="checkbox" checked={row.can_view} onChange={() => flip(idx, 'can_view')} /></td>
                  <td>{VIEW_ONLY_MODULES.includes(row.module_key) ? <span className="muted">—</span> : <input type="checkbox" checked={row.can_edit} onChange={() => flip(idx, 'can_edit')} />}</td>
                  <td>{VIEW_ONLY_MODULES.includes(row.module_key) ? <span className="muted">—</span> : <input type="checkbox" checked={row.can_delete} onChange={() => flip(idx, 'can_delete')} />}</td>
                </tr>
              ))}
              {!matrix.length && <tr><td colSpan={4} className="muted">This role has no modules assigned yet.</td></tr>}
            </tbody>
          </table>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-outline" onClick={() => setAccessRole(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveMatrix}>Save</button>
          </div>
        </Modal>
      )}

      {viewing && (
        <Modal title={`Role — ${viewing.role_name}`} onClose={() => setViewing(null)}>
          <div className="detail-list">
            <div><span>Title</span><span>{viewing.role_name}</span></div>
            <div><span>Description</span><span>{viewing.description || '-'}</span></div>
            <div><span>Modules</span><span>{viewing.modules.join(', ') || '-'}</span></div>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
