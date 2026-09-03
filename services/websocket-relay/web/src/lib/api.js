// API 는 SPA 와 같은 경로(/relay/dashboard) 아래에 있다.
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
    // 세션이 끊기면 **어떤 호출이든** 로그인으로 보낸다.
    //
    // 예전에는 이 처리가 usePolling(조회) 안에만 있어서, 단말을 삭제하거나
    // 저장하려는 순간 세션이 만료되면 "unauthorized" 라는 빨간 줄만 뜨고
    // 그 자리에 머물렀다. 사람은 자기가 뭘 잘못했는지 모른 채 다시 눌러 본다.
    if (res.status === 401) {
      redirectToLogin(data?.loginUrl);
      // 리다이렉트는 즉시 일어나지 않는다. 부르는 쪽이 이어서 렌더링하지
      // 않도록 던지긴 하되, 화면에는 굳이 오류로 그리지 않는다.
      throw new ApiError(data?.message || '세션이 만료되었습니다.', 401, 'unauthorized', data);
    }
    throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status, data?.error, data);
  }

  return data;
}

/**
 * manager 로그인으로 보낸다. 돌아올 곳을 next 에 실어 준다.
 *
 * 한 화면에서 여러 요청이 동시에 401 을 받는 일이 흔해서(폴링 + 사용자 동작)
 * 한 번만 움직이도록 잠근다. 잠그지 않으면 location.href 가 연달아 바뀌며
 * 뒤로 가기 이력이 지저분해진다.
 */
let redirecting = false;
export function redirectToLogin(loginUrl) {
  if (redirecting) return;
  redirecting = true;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `${loginUrl || '/manager/login'}?next=${next}`;
}

export const api = {
  me: () => request('/me'),
  overview: () => request('/overview'),
  rooms: () => request('/rooms'),

  mobiles: () => request('/mobiles'),
  createMobile: (body) => request('/mobiles', { method: 'POST', body: JSON.stringify(body) }),
  updateMobile: (id, body) => request(`/mobiles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  toggleMobile: (id) => request(`/mobiles/${id}/toggle-active`, { method: 'PATCH' }),
  deleteMobile: (id) => request(`/mobiles/${id}`, { method: 'DELETE' }),
  // 시험 푸시. dryRun 이면 구글에 물어보기만 하고 단말에는 가지 않는다.
  testPush: (id, dryRun) => request(`/mobiles/${id}/test-push`, {
    method: 'POST', body: JSON.stringify({ dryRun: Boolean(dryRun) }),
  }),

  homenet: () => request('/homenet'),
  createHomenet: (body) => request('/homenet', { method: 'POST', body: JSON.stringify(body) }),
  deleteHomenet: (id) => request(`/homenet/${id}`, { method: 'DELETE' }),

  // 등록 승인
  enrollments: (address) => request(`/enrollments${address ? `?address=${encodeURIComponent(address)}` : ''}`),
  approveEnrollment: (id, grants) => request(`/enrollments/${id}/approve`, { method: 'POST', body: JSON.stringify(grants) }),
  rejectEnrollment: (id) => request(`/enrollments/${id}`, { method: 'DELETE' }),
  setMobilePermissions: (id, grants) => request(`/mobiles/${id}/permissions`, { method: 'PATCH', body: JSON.stringify(grants) }),
  homes: () => request('/homes'),

  // 단지 ID
  complex: () => request('/complex'),
  updateComplex: (body) => request('/complex', { method: 'PUT', body: JSON.stringify(body) }),

  // FCM 서비스 계정 키
  firebase: () => request('/firebase'),
  analyzeFirebase: (content) => request('/firebase/analyze', { method: 'POST', body: JSON.stringify({ content }) }),
  installFirebase: (content) => request('/firebase', { method: 'POST', body: JSON.stringify({ content }) }),
  verifyFirebase: () => request('/firebase/verify', { method: 'POST' }),
  deleteFirebase: () => request('/firebase', { method: 'DELETE' }),
};
