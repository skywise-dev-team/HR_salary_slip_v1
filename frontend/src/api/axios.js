import axios from 'axios';
import { API_BASE } from '../config/apiBase.js';

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
  (err) => {
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
