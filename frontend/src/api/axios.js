import axios from 'axios';
import { API_BASE } from '../config/apiBase.js';
import { askForReason } from '../utils/reasonPrompt.js';

const api = axios.create({
  baseURL: API_BASE
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    // 428: the server will only send this change for approval together
    // with the reason for it. Ask the person, then send the very same
    // request again with the reason attached. Cancelling leaves the change
    // unsent.
    if (err.response?.status === 428 && err.config && !err.config._reasonAsked) {
      const reason = await askForReason();
      if (reason) {
        err.config._reasonAsked = true;
        err.config.headers.set('X-Change-Reason', encodeURIComponent(reason));
        return api.request(err.config);
      }
      err.response.data = { message: 'Not sent - remarks are required to send a change for approval.' };
    }
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!window.location.pathname.includes('/login')) window.location.href = '/login';
    }
    // A staff session that's ended up outside the company network (e.g. a
    // laptop taken home mid-session) — sign out cleanly and say why, rather
    // than leaving every page failing with an unexplained error. On the
    // login page itself the server's own message is shown by the form.
    if (err.response?.data?.code === 'NETWORK_RESTRICTED') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!window.location.pathname.includes('/login')) window.location.href = '/login?reason=network';
    }
    return Promise.reject(err);
  }
);

export default api;
