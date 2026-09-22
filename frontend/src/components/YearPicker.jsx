import { useEffect, useRef, useState } from 'react';

const GRID_SIZE = 12;

export default function YearPicker({ value, onChange, placeholder = 'Select year' }) {
  const [open, setOpen] = useState(false);
  const currentYear = new Date().getFullYear();
  const [rangeStart, setRangeStart] = useState(() => {
    const base = value ? Number(value) : currentYear;
    return base - (base % GRID_SIZE) - 4; // centers roughly around the current/selected year
  });
  const wrapperRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const years = Array.from({ length: GRID_SIZE }, (_, i) => rangeStart + i);

  const select = (year) => {
    onChange(String(year));
    setOpen(false);
  };

  return (
    <div className="year-picker" ref={wrapperRef}>
      <button type="button" className="year-picker-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{value || placeholder}</span>
        <span className="year-picker-caret">📅</span>
      </button>

      {open && (
        <div className="year-picker-popover">
          <div className="year-picker-nav">
            <button type="button" onClick={() => setRangeStart((r) => r - GRID_SIZE)}>&laquo;</button>
            <span>{years[0]} – {years[years.length - 1]}</span>
            <button type="button" onClick={() => setRangeStart((r) => r + GRID_SIZE)}>&raquo;</button>
          </div>
          <div className="year-picker-grid">
            {years.map((y) => (
              <button
                type="button"
                key={y}
                className={
                  'year-cell' +
                  (String(y) === String(value) ? ' year-cell-selected' : '') +
                  (y === currentYear ? ' year-cell-current' : '')
                }
                onClick={() => select(y)}
              >
                {y}
              </button>
            ))}
          </div>
          {value && (
            <button type="button" className="year-picker-clear" onClick={() => select('')}>Clear</button>
          )}
        </div>
      )}
    </div>
  );
}
