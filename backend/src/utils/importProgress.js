// Streams newline-delimited JSON (NDJSON) progress updates for a bulk Excel
// import, so the frontend can show a live percentage instead of a static
// "Importing..." label. Each line written is one JSON object followed by
// '\n':
//   {"type":"total","total":N}
//     Sent once, right before row processing starts.
//   {"type":"progress","processed":X,"total":N,"percent":P}
//     Sent as rows are scanned through the sheet, throttled to at most one
//     update per percentage point so a large file doesn't flood the
//     connection with thousands of tiny writes.
//   {"type":"done", ...results}
//     Sent once at the end, carrying the exact same results object the
//     route used to send back as a single JSON response — the frontend
//     reads this line to get the final inserted/updated/skipped/errors counts.
//
// The response's Content-Type is switched to application/x-ndjson so a
// plain axios/fetch caller doesn't try to auto-parse the whole body as one
// JSON value.
function startImportProgress(res, totalRows) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.write(JSON.stringify({ type: 'total', total: totalRows }) + '\n');

  let processed = 0;
  let lastPercent = -1;

  return {
    // Call once per row scanned (whether it was inserted, updated, skipped,
    // or errored) so the percentage reflects progress through the file.
    reportProgress() {
      processed++;
      const percent = totalRows > 0 ? Math.floor((processed / totalRows) * 100) : 100;
      if (percent !== lastPercent) {
        lastPercent = percent;
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: 'progress', processed, total: totalRows, percent }) + '\n');
        }
      }
    },
    // Call once, after commit, with the same results object the route
    // previously returned via res.json(results).
    sendDone(results) {
      if (!res.writableEnded) {
        res.write(JSON.stringify({ type: 'done', ...results }) + '\n');
        res.end();
      }
    },
    // Call when a fatal, unrecoverable error happens mid-import — after
    // streaming has already begun, a normal JSON error response can no
    // longer be sent (HTTP headers are already committed), so the
    // connection would otherwise just break with no message at all. This
    // reports the error as one last NDJSON line instead, so the frontend
    // can still show the real reason rather than a generic network-failure
    // fallback.
    sendError(message) {
      if (!res.writableEnded) {
        res.write(JSON.stringify({ type: 'error', message }) + '\n');
        res.end();
      }
    }
  };
}

module.exports = { startImportProgress };
