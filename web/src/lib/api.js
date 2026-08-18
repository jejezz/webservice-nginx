// 모든 API는 SPA와 같은 오리진의 /manager/api 아래에 있다.
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/api`;

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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
    throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status, data?.error);
  }

  return data;
}

export const api = {
  login: (username, password) =>
    request('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/logout', { method: 'POST' }),
  me: () => request('/me'),
  overview: () => request('/overview'),
  serviceHealth: (name) => request(`/services/${encodeURIComponent(name)}/health`),

  // 관리자 콘솔 — 일반 로그인과 별개의 세션을 쓴다.
  admin: {
    login: (username, password) =>
      request('/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout: () => request('/admin/logout', { method: 'POST' }),
    me: () => request('/admin/me'),
    list: () => request('/admin/administrators'),
    create: (payload) =>
      request('/admin/administrators', { method: 'POST', body: JSON.stringify(payload) }),
    update: (id, patch) =>
      request(`/admin/administrators/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id) => request(`/admin/administrators/${id}`, { method: 'DELETE' }),
  },
};
