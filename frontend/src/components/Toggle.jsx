export function Toggle({ checked, onChange, disabled }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
    </label>
  );
}

export function StatusBadge({ status }) {
  const active = status === 'ACTIVE';
  return <span className={`badge ${active ? 'badge-active' : 'badge-inactive'}`}>{status}</span>;
}
