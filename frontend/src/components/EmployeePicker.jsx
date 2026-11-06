import { useEffect, useRef, useState } from 'react';

// A drop-down for choosing ONE employee, with a search box built in: type any
// part of the name or the Employee ID and the list narrows as you type (the
// same way the search in Employee Master works).
//
//   options      [{ id, employee_id, full_name, ... }]
//   value        the chosen employee's id ('' for none)
//   onChange     called with the new id ('' when cleared)
//   required     the form cannot be submitted until an employee is chosen
//   disabled     shows the choice but does not let it be changed
const labelOf = (e) => `${e.full_name} (${e.employee_id})`;

export default function EmployeePicker({ options, value, onChange, placeholder = 'Search name or employee ID', required = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

  const selected = value ? options.find((o) => String(o.id) === String(value)) : null;

  useEffect(() => {
    const close = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) { setOpen(false); setQuery(''); }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Browser's own "required" message works for a blank box; this covers text
  // typed without picking anyone from the list.
  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.setCustomValidity(!selected && query.trim() ? 'Please choose an employee from the list' : '');
  }, [selected, query]);

  const needle = query.trim().toLowerCase();
  const filtered = (needle
    ? options.filter((o) => labelOf(o).toLowerCase().includes(needle) || String(o.employee_id).toLowerCase().includes(needle))
    : options
  ).slice(0, 100);

  const pick = (o) => { onChange(String(o.id)); setQuery(''); setOpen(false); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open && filtered[active]) { e.preventDefault(); pick(filtered[active]); }
    else if (e.key === 'Escape') { setOpen(false); setQuery(''); }
  };

  // While the list is open the box is for searching; otherwise it shows
  // whoever is chosen.
  const shown = open ? query : (selected ? labelOf(selected) : query);

  return (
    <div className="search-autocomplete" ref={wrapperRef}>
      <input
        ref={inputRef}
        value={shown}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoComplete="off"
        onFocus={() => { if (!disabled) { setOpen(true); setActive(0); } }}
        onClick={() => { if (!disabled) setOpen(true); }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          if (value) onChange('');
        }}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <div className="search-autocomplete-list">
          {filtered.map((o, i) => (
            <div
              key={o.id}
              className="search-autocomplete-item"
              style={i === active ? { background: '#f4f6f9' } : undefined}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setActive(i)}
            >
              {labelOf(o)}{o.designation ? <span className="muted small"> — {o.designation}</span> : null}
            </div>
          ))}
          {!filtered.length && <div className="search-autocomplete-item muted">No employee found.</div>}
        </div>
      )}
    </div>
  );
}
