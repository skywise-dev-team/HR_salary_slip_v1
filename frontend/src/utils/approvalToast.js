// The same endpoint can now either apply an action immediately (Admin) or
// stage it for approval (everyone else) — the server signals which one
// happened via the HTTP status (202 = staged, pending) rather than the
// message text, so this checks that directly instead of guessing from
// wording.
//
// message and note serve different purposes and both matter when present
// together: message is the outcome ("3 user(s) deleted"), note is *why*
// something couldn't fully happen ("the default admin account was
// skipped"). Showing only one would silently drop the explanation the
// person actually needs — e.g. a bulk delete that succeeds for most rows
// but explains why a few were excluded.
export function showResultToast(showToast, res, defaultMessage) {
  const pending = res.status === 202;
  const parts = [res.data?.message, res.data?.note].filter(Boolean);
  const message = parts.length ? parts.join(' ') : defaultMessage;
  showToast(message, pending || res.data?.note ? 'info' : 'success');
}
