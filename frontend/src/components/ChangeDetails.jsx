import { useState } from 'react';

const KIND = {
  new: { label: 'New', color: '#166534', bg: '#dcfce7' },
  change: { label: 'Change', color: '#1e40af', bg: '#dbeafe' },
  delete: { label: 'Delete', color: '#991b1b', bg: '#fee2e2' }
};
const FIRST_SHOWN = 50;

function Entry({ entry, selectable, checked, onToggle }) {
  const kind = KIND[entry.kind] || KIND.change;
  const isChange = entry.kind === 'change';
  const fields = entry.fields || [];
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8, background: '#fff' }}>
      <div style={{ padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', borderBottom: fields.length || entry.note ? '1px solid var(--border)' : 'none' }}>
        {selectable && entry.itemId != null && (
          <input type="checkbox" checked={checked} onChange={() => onToggle(entry.itemId)} title="Select this record" />
        )}
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: kind.color, background: kind.bg }}>{kind.label}</span>
        <strong>{entry.title}</strong>
        {entry.subtitle && <span className="muted small">{entry.subtitle}</span>}
      </div>
      {entry.note && <div className="muted small" style={{ padding: '8px 10px' }}>{entry.note}</div>}
      {fields.length > 0 && (
        <table className="table" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ width: '34%' }}>Field</th>
              {isChange ? <><th>Current</th><th>Requested</th></> : <th>{entry.kind === 'delete' ? 'Details' : 'Value'}</th>}
            </tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={i}>
                <td>{f.label}</td>
                {isChange ? (
                  <>
                    <td style={{ color: '#991b1b', textDecoration: f.before && f.before !== '—' ? 'line-through' : 'none' }}>{f.before}</td>
                    <td style={{ color: '#166534', fontWeight: 600 }}>{f.after}</td>
                  </>
                ) : (
                  <td>{f.after}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// The "what is going to change" view of an approval request: for each
// employee / user / establishment / salary record involved, every changed
// field with its current and requested value.
//
// With `selectable`, each record gets a tick box so the approver can decide
// only some of them: `picked` is the list of ticked itemIds, `onToggle(itemId)`
// ticks one, `onToggleAll(itemIds)` ticks or clears them all.
export default function ChangeDetails({ details, selectable = false, picked = [], onToggle, onToggleAll }) {
  const [showAll, setShowAll] = useState(false);
  if (!details) return <p className="muted small">No change details are available for this request.</p>;
  const entries = details.entries || [];
  const shown = showAll ? entries : entries.slice(0, FIRST_SHOWN);
  const allIds = entries.map((e) => e.itemId).filter((id) => id != null);

  return (
    <div>
      {details.note && <p className="muted small" style={{ marginTop: 0 }}>{details.note}</p>}
      {entries.length > 1 && <p className="muted small" style={{ margin: '0 0 6px' }}>{entries.length} item(s) in this request</p>}
      {selectable && (
        <p style={{ margin: '0 0 8px' }}>
          <label style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={allIds.length > 0 && allIds.every((id) => picked.includes(id))}
              onChange={() => onToggleAll(allIds)}
            />{' '}
            Select all ({allIds.length})
          </label>
        </p>
      )}
      {shown.map((entry, i) => (
        <Entry key={i} entry={entry} selectable={selectable} checked={picked.includes(entry.itemId)} onToggle={onToggle} />
      ))}
      {!showAll && entries.length > FIRST_SHOWN && (
        <button type="button" className="link-btn" onClick={() => setShowAll(true)}>Show all {entries.length} items</button>
      )}
      {details.hiddenEntries > 0 && (
        <p className="muted small">{details.hiddenEntries} more item(s) are part of this request but are not listed here.</p>
      )}
    </div>
  );
}