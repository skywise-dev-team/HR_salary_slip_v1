import { useEffect, useRef, useState } from 'react';

// Drop-down with tick boxes for choosing which establishments a user may work
// with. "Select all" means every establishment, including ones created later;
// ticking the boxes one by one gives access to exactly those.
//
//   value    { all: boolean, ids: number[] }
//   onChange called with the new { all, ids }
//   options  [{ id, name }]
// The app's global form styles stretch every input to full width and give
// labels their own spacing, so the tick boxes and rows are pinned here.
const ROW = {
  display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 10,
  width: '100%', margin: 0, padding: '8px 12px', boxSizing: 'border-box', cursor: 'pointer',
  whiteSpace: 'nowrap', fontWeight: 400
};
const TICK = { width: 16, height: 16, minWidth: 16, flex: '0 0 16px', margin: 0, padding: 0 };
const NAME = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

export default function EstablishmentPicker({ options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const allIds = options.map((o) => o.id);
  const isTicked = (id) => value.all || value.ids.includes(id);
  const shown = filter.trim()
    ? options.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : options;

  const toggleAll = () => onChange(value.all ? { all: false, ids: [] } : { all: true, ids: [] });
  const toggleOne = (id) => {
    if (value.all) { onChange({ all: false, ids: allIds.filter((x) => x !== id) }); return; }
    onChange({ all: false, ids: value.ids.includes(id) ? value.ids.filter((x) => x !== id) : [...value.ids, id] });
  };

  let summary = 'No establishment selected';
  if (value.all) summary = 'All establishments';
  else if (value.ids.length) {
    const names = options.filter((o) => value.ids.includes(o.id)).map((o) => o.name);
    summary = names.length <= 2 ? names.join(', ') : `${names.length} establishments selected`;
  }

  return (
    <div ref={box}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: '#fff', cursor: 'pointer'
        }}
      >
        <span style={{ color: !value.all && !value.ids.length ? '#9ca3af' : 'inherit' }}>{summary}</span>
        <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginTop: 4, background: '#fff' }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input placeholder="Search establishment" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%' }} />
          </div>
          <label style={{ ...ROW, borderBottom: '1px solid var(--border)', fontWeight: 600 }}>
            <input type="checkbox" style={TICK} checked={value.all} onChange={toggleAll} />
            <span style={NAME}>Select all</span>
          </label>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {shown.map((o) => (
              <label key={o.id} style={ROW} title={o.name}>
                <input type="checkbox" style={TICK} checked={isTicked(o.id)} onChange={() => toggleOne(o.id)} />
                <span style={NAME}>{o.name}</span>
              </label>
            ))}
            {!shown.length && <div className="muted small" style={{ padding: '8px 10px' }}>No establishments found.</div>}
          </div>
        </div>
      )}
    </div>
  );
}