// Shared pagination bar — page-number buttons (with ellipsis for many
// pages), a "Showing X-Y of Z" indicator, and a page-size dropdown.
// Purely a display-layer control: the caller still holds the entire
// filtered/searched dataset and just slices out the current page from it,
// so search and filters always operate over everything, never just the
// page currently in view.
export default function Pagination({ page, setPage, pageSize, setPageSize, totalItems, pageSizeOptions }) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const startItem = totalItems === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const endItem = Math.min(clampedPage * pageSize, totalItems);

  // A compact set of page numbers to show: always the first and last page,
  // plus a small window around the current page, with "…" filling any gap
  // — avoids rendering e.g. 31 separate page buttons for 1500+ rows.
  const pages = [];
  const addPage = (n) => { if (n >= 1 && n <= totalPages && !pages.includes(n)) pages.push(n); };
  addPage(1);
  for (let p = clampedPage - 1; p <= clampedPage + 1; p++) addPage(p);
  addPage(totalPages);
  pages.sort((a, b) => a - b);

  if (totalItems === 0) return null;

  return (
    <div className="pagination-bar">
      <div className="pagination-controls">
        <button className="pagination-nav-link" disabled={clampedPage <= 1} onClick={() => setPage(clampedPage - 1)}>&laquo; Previous</button>
        {pages.map((p, i) => (
          <span key={p} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && p - pages[i - 1] > 1 && <span className="pagination-ellipsis">…</span>}
            <button
              className={`pagination-page-btn${p === clampedPage ? ' active' : ''}`}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          </span>
        ))}
        <button className="pagination-nav-link" disabled={clampedPage >= totalPages} onClick={() => setPage(clampedPage + 1)}>Next &raquo;</button>
      </div>
      <div className="pagination-info">Showing {startItem}-{endItem} of {totalItems}</div>
      {pageSizeOptions && (
        <select
          className="pagination-size-select"
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
        >
          {pageSizeOptions.map((n) => <option key={n} value={n}>{n} / page</option>)}
        </select>
      )}
    </div>
  );
}
