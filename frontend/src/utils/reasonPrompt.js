// Lets code outside React (the axios interceptor) ask the person for the
// reason behind a change that is being sent for approval. The
// <ReasonPromptHost /> component mounted once at the top of the app
// registers the function that actually shows the dialog.
let handler = null;

export function registerReasonPrompt(fn) {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

// Resolves with the reason text, or null if the person cancelled.
export function askForReason() {
  return handler ? handler() : Promise.resolve(null);
}