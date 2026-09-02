// API는 SPA와 같은 경로(/kamailio/dashboard) 아래에 있다.
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/api`;

export class ApiError extends Error {
  constructor(message, status, code, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status, data?.error, data);
  }

  return data;
}

export const api = {
  // systemd 저널 (이 서비스는 pm2 가 아니라 systemd 가 띄운다)
  logs: ({ lines, minutes, grep } = {}) => {
    const q = new URLSearchParams();
    if (lines) q.set('lines', lines);
    if (minutes) q.set('minutes', minutes);
    if (grep) q.set('grep', grep);
    const qs = q.toString();
    return request(`/logs${qs ? `?${qs}` : ''}`);
  },
  overview: () => request('/overview'),
  registrations: () => request('/registrations'),
  websockets: () => request('/websockets'),
  stats: () => request('/stats'),
  accounts: () => request('/accounts'),
  createAccount: (payload) => request('/accounts', { method: 'POST', body: JSON.stringify(payload) }),
  updateAccount: (id, patch) => request(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),
};
