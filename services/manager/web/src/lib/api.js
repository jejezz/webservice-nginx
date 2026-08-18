// 모든 API는 SPA와 같은 오리진의 <base>/api 아래에 있다. (기본 '/api')
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/api`;

export class ApiError extends Error {
  constructor(message, status, code, reason) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    // 같은 code 안에서 상황을 더 나눌 때 쓴다. (예: password_confirm_required 의 signup / reset)
    this.reason = reason;
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
    throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status, data?.error, data?.reason);
  }

  return data;
}

export const api = {
  // 로그인 화면이 어느 장비인지 표시하기 위해 부른다. 인증 전에도 응답한다.
  host: () => request('/host'),

  // passwordConfirm 은 비밀번호가 새로 저장되는 경우(신규 등록, 승인 전 재설정)에만 보낸다.
  // 서버는 이 값이 '없음'인지 '빈 문자열'인지를 구분하므로 undefined 면 아예 넣지 않는다.
  login: (username, password, passwordConfirm) =>
    request('/login', {
      method: 'POST',
      body: JSON.stringify(
        passwordConfirm === undefined
          ? { username, password }
          : { username, password, passwordConfirm }
      ),
    }),
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
