// Where the API lives. Set VITE_API_BASE_URL (frontend/.env) to pin it to one
// fixed address. If it's left unset or empty, the app calls the API on the
// SAME host the page itself was loaded from, on the backend's default port
// 5000 — so a single build works for everyone at once: office staff who open
// the app at the server's LAN address talk to the API over the LAN, and
// people who open it at the public address talk to it there, with no
// rebuild per audience. That also keeps staff traffic on the LAN, so the
// server sees each staff member's real office address for the staff network
// restriction. During local development (localhost:5173) this resolves to
// http://localhost:5000, exactly as before.
export const API_BASE =
  import.meta.env.VITE_API_BASE_URL || `${window.location.protocol}//${window.location.hostname}:5000`;
