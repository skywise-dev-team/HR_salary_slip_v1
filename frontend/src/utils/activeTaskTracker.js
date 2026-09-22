// A simple in-memory counter, deliberately outside React's context system —
// the mandatory session timeout (in AuthContext) needs to know whether a
// long-running task (currently: a bulk Excel import) is in progress, so it
// can defer logging someone out mid-task rather than interrupting it. Using
// a plain shared module instead of wiring AuthContext and ImportContext
// together keeps the two contexts independent of each other.
let activeCount = 0;

export function startTask() {
  activeCount++;
}

export function endTask() {
  activeCount = Math.max(0, activeCount - 1);
}

export function isTaskActive() {
  return activeCount > 0;
}
