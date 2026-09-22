import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import api from '../api/axios.js';
import { useToast } from '../context/ToastContext.jsx';

const EMPTY = { est_code: '', name: '', signatory_name: '', address: '' };
const MAX_LOGO_SIGNATURE_MB = 5;

export default function Establishments() {
  const [rows, setRows] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [files, setFiles] = useState({});
  const [error, setError] = useState('');
  const { showToast } = useToast();

  const load = () => api.get('/api/establishments').then(({ data }) => setRows(data));
  useEffect(() => { load(); }, []);

  const openAdd = () => { setEditing(null); setForm(EMPTY); setFiles({}); setError(''); setModalOpen(true); };
  const openEdit = (row) => { setEditing(row); setForm(row); setFiles({}); setError(''); setModalOpen(true); };

  const pickFile = (field) => (e) => {
    const file = e.target.files[0];
    if (file && file.size > MAX_LOGO_SIGNATURE_MB * 1024 * 1024) {
      setError(`"${file.name}" is larger than ${MAX_LOGO_SIGNATURE_MB} MB — please choose a smaller file.`);
      e.target.value = '';
      return;
    }
    setError('');
    setFiles({ ...files, [field]: file });
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
    if (files.logo) fd.append('logo', files.logo);
    if (files.signature) fd.append('signature', files.signature);

    try {
      if (editing) await api.put(`/api/establishments/${editing.id}`, fd);
      else await api.post('/api/establishments', fd);
      setModalOpen(false);
      showToast(editing ? 'Establishment updated successfully!' : 'Establishment added successfully!');
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    }
  };

  const remove = async (row) => {
    if (!confirm(`Delete establishment "${row.name}"?`)) return;
    await api.delete(`/api/establishments/${row.id}`);
    showToast('Establishment deleted.');
    load();
  };

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Establishments</h1>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>Add establishment</button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Code</th><th>Name</th><th>Signatory</th><th>Address</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.est_code}</td>
                <td>{r.name}</td>
                <td>{r.signatory_name || '-'}</td>
                <td>{r.address || '-'}</td>
                <td>
                  <button className="link-btn" onClick={() => openEdit(r)}>Edit</button>
                  <button className="link-btn danger" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="muted">No establishments yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <Modal title={editing ? 'Edit establishment' : 'Add establishment'} onClose={() => setModalOpen(false)}>
          <form onSubmit={submit} className="form-grid">
            {error && <div className="alert alert-error span-2">{error}</div>}

            <div>
              <label>Establishment code</label>
              <input value={form.est_code} onChange={(e) => setForm({ ...form, est_code: e.target.value })} required />
            </div>
            <div>
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div>
              <label>Signatory name</label>
              <input value={form.signatory_name || ''} onChange={(e) => setForm({ ...form, signatory_name: e.target.value })} />
            </div>
            <div>
              <label>Address</label>
              <input value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label>Logo</label>
              <input type="file" accept="image/*" onChange={pickFile('logo')} />
              <small className="hint">Max {MAX_LOGO_SIGNATURE_MB} MB.</small>
            </div>
            <div>
              <label>Signature image</label>
              <input type="file" accept="image/*" onChange={pickFile('signature')} />
              <small className="hint">Max {MAX_LOGO_SIGNATURE_MB} MB.</small>
            </div>

            <div className="span-2 modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="btn btn-primary">{editing ? 'Save changes' : 'Add establishment'}</button>
            </div>
          </form>
        </Modal>
      )}
    </Layout>
  );
}
