import { useEffect, useRef, useState } from 'react';

// A plain text input that also shows a dropdown of matching suggestions as
// you type (filtered letter-by-letter/digit-by-digit against `options`).
// Typing freely still works without picking a suggestion — the dropdown is
// just a faster way to land on one exact match.
export default function SearchAutocomplete({ value, onChange, options, placeholder, getLabel, getKey, getValue }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const needle = value.trim().toLowerCase();
  const filtered = needle
    ? options.filter((o) => getLabel(o).toLowerCase().includes(needle)).slice(0, 8)
    : [];

  return (
    <div className="search-autocomplete" ref={wrapperRef}>
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
      />
      {open && filtered.length > 0 && (
        <div className="search-autocomplete-list">
          {filtered.map((o) => (
            <div
              key={getKey(o)}
              className="search-autocomplete-item"
              onMouseDown={() => { onChange(getValue ? getValue(o) : getLabel(o)); setOpen(false); }}
            >
              {getLabel(o)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
