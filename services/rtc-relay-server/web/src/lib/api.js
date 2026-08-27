// API 는 SPA 와 같은 경로(/iot/dashboard) 아래에 있다.
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
  me: () => request('/me'),
  overview: () => request('/overview'),
  rooms: () => request('/rooms'),

  mobiles: () => request('/mobiles'),
  toggleMobile: (id) => request(`/mobiles/${id}/toggle-active`, { method: 'PATCH' }),
  deleteMobile: (id) => request(`/mobiles/${id}`, { method: 'DELETE' }),

  homenet: () => request('/homenet'),
  deleteHomenet: (id) => request(`/homenet/${id}`, { method: 'DELETE' }),
};
