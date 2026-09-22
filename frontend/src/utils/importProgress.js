// Consumes a bulk-import POST response streamed as newline-delimited JSON
// (NDJSON) — see backend/src/utils/importProgress.js for the line shapes
// ({type:'total'}, {type:'progress'}, {type:'done', ...results}) — and
// calls `onEvent` with each parsed line as it arrives, so a page can show a
// live percentage instead of a static "Importing..." label.
//
// Relies on axios' onDownloadProgress exposing the underlying XHR (via
// progressEvent.event.target) so we can read the response body as it
// streams in, before the request has fully completed.
export async function streamImport(api, url, formData, { signal, onEvent }) {
  let parsedLength = 0;

  const consume = (text) => {
    if (typeof text !== 'string' || text.length <= parsedLength) return;
    const newText = text.slice(parsedLength);
    const lastNewline = newText.lastIndexOf('\n');
    if (lastNewline === -1) return;
    const completeChunk = newText.slice(0, lastNewline);
    parsedLength += lastNewline + 1;
    for (const line of completeChunk.split('\n')) {
      if (!line.trim()) continue;
      try { onEvent(JSON.parse(line)); } catch { /* ignore a malformed/partial line */ }
    }
  };

  try {
    const response = await api.post(url, formData, {
      signal,
      responseType: 'text',
      onDownloadProgress: (progressEvent) => consume(progressEvent.event?.target?.responseText)
    });

    // Parse whatever's left in the final response body (covers the case
    // where the last line — the "done" event — arrived only after the
    // request settled, or onDownloadProgress didn't fire for the final flush).
    consume(typeof response.data === 'string' ? (response.data.endsWith('\n') ? response.data : response.data + '\n') : '');

    // A non-Admin's upload doesn't stream at all — the server responds
    // immediately with a plain 202 ({ message: "Submitted for approval,
    // pending." }) instead of NDJSON events, since nothing is actually
    // being processed yet. That single line still gets parsed above and
    // passed to onEvent like any other line, but it has no `type` field, so
    // callers checking `evt.type === 'done'` would otherwise silently never
    // see it. Returning the status lets a caller detect this case
    // explicitly rather than guessing from the event's shape.
    return { status: response.status };
  } catch (err) {
    // Because responseType is 'text' (needed to read the NDJSON stream as
    // it arrives), a plain JSON error response — e.g. the whole-file
    // rejection when a required cell is blank — also arrives as a raw
    // string instead of being auto-parsed by axios. Recover the
    // { message: "..." } object here so the existing
    // `err.response?.data?.message` handling in every caller keeps working.
    if (typeof err.response?.data === 'string') {
      try { err.response.data = JSON.parse(err.response.data); } catch { /* not JSON — leave the raw text as-is */ }
    }
    throw err;
  }
}
