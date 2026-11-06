import { useEffect, useRef, useState } from 'react';

// Drop-down with tick boxes for choosing one or more approvers.
//   options  [{ id, label, detail }]
//   value    number[] of selected ids
//   onChange called with the new array
const ROW = {
  display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 10,
  width: '100%', margin: 0, padding: '8px 12px', boxSizing: 'border-box', cursor: 'pointer',
  whiteSpace: 'nowrap', fontWeight: 400
};
const TICK = { width: 16, height: 16, minWidth: 16, flex: '0 0 16px', margin: 0, padding: 0 };

export default function ApproverPicker({ options, value, onChange, placeholder = 'Select approver(s)', searchPlaceholder = 'Search approver', noun = 'approvers', emptyText = 'No approvers found.', floating = false }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const q = filter.trim().toLowerCase();
  const shown = q ? options.filter((o) => `${o.label} ${o.detail || ''}`.toLowerCase().includes(q)) : options;
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  const names = options.filter((o) => value.includes(o.id)).map((o) => o.label);
  const summary = !names.length ? placeholder : (names.length <= 3 ? names.join(', ') : `${names.length} ${noun} selected`);

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: '#fff', cursor: 'pointer'
        }}
      >
        <span style={{ color: names.length ? 'inherit' : '#9ca3af' }}>{summary}</span>
        <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginTop: 4, background: '#fff', ...(floating ? { position: 'absolute', zIndex: 30, left: 0, right: 0, boxShadow: '0 6px 18px rgba(0,0,0,.12)' } : {}) }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input placeholder={searchPlaceholder} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {shown.map((o) => (
              <label key={o.id} style={ROW}>
                <input type="checkbox" style={TICK} checked={value.includes(o.id)} onChange={() => toggle(o.id)} />
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {o.label}
                  {o.detail ? <span className="muted small"> — {o.detail}</span> : null}
                </span>
              </label>
            ))}
            {!shown.length && <div className="muted small" style={{ padding: '8px 10px' }}>{emptyText}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
