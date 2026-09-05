// 모든 API는 SPA와 같은 오리진의 /manager/api 아래에 있다.
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/api`;

export class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    // 항목별 오류처럼 본문에 더 실려 오는 것이 있다 (설정 폼).
    this.data = data;
    // 같은 code 안에서 상황을 더 나눌 때 쓴다.
    // (예: password_confirm_required 의 signup / reset)
    this.reason = data?.reason;
    // too_many_attempts 에서만 온다 — 로그인 화면이 카운트다운을 보여줄 때 쓴다.
    this.retryAfterSec = data?.retryAfterSec;
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
  // 로그인 화면이 어느 장비인지 표시하기 위해 부른다. 인증 전에도 응답한다.
  host: () => request('/host'),

  // passwordConfirm 은 비밀번호가 **새로 저장되는** 경우(신규 등록, 승인 전
  // 재설정)에만 보낸다. 서버는 '없음' 과 '빈 문자열' 을 구분하므로 undefined 면
  // 아예 넣지 않는다.
  login: (username, password, passwordConfirm) =>
    request('/login', {
      method: 'POST',
      body: JSON.stringify(
        passwordConfirm === undefined ? { username, password } : { username, password, passwordConfirm }
      ),
    }),
  logout: () => request('/logout', { method: 'POST' }),
  me: () => request('/me'),
  overview: () => request('/overview'),
  serviceHealth: (name) => request(`/services/${encodeURIComponent(name)}/health`),

  // RTP·시그널링·내부 HTTP 포트 전체 지도. 공유기 포워딩 확인용 (docs/port-map.md).
  portMap: () => request('/port-map'),

  // 문서(git 이 추적하는 .md 전부)와 변경 이력(git log).
  docs: {
    list: () => request('/docs'),
    content: (path) => request(`/docs/content?path=${encodeURIComponent(path)}`),
  },
  changelog: (scope, limit) => {
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    if (limit) params.set('limit', limit);
    const qs = params.toString();
    return request(`/changelog${qs ? `?${qs}` : ''}`);
  },

  // 구축 마법사 — 단계 정의와 점검 실행.
  setup: {
    overview: () => request('/setup'),
    check: (stepId) => request(`/setup/check/${encodeURIComponent(stepId)}`, { method: 'POST' }),
    // 파라미터를 서비스의 settings.ini 에 쓴다. 반영은 사람이 --apply 로 한다.
    saveSettings: (stepId, values) =>
      request(`/setup/settings/${encodeURIComponent(stepId)}`, {
        method: 'PUT',
        body: JSON.stringify(values),
      }),

    // 사람만 확인할 수 있는 것의 기록. 통과로 바꾸는 것이 아니라 적어 두는 것이다.
    attest: (stepId, note) =>
      request(`/setup/attest/${encodeURIComponent(stepId)}`, {
        method: 'POST',
        body: JSON.stringify({ note: note || '' }),
      }),
    unattest: (stepId) =>
      request(`/setup/attest/${encodeURIComponent(stepId)}`, { method: 'DELETE' }),
  },

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
