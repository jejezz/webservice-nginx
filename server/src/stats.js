/**
 * 이 대시보드 프로세스 자신의 런타임 통계. 메모리에만 있고 재시작하면 초기화된다.
 * (Kamailio 의 통계는 RPC 로 가져오므로 여기 담지 않는다)
 */
const startedAt = Date.now();

const counters = {
  apiRequests: 0,
  rpcCalls: 0,
  rpcErrors: 0,
};

const recent = [];
const RECENT_LIMIT = 30;

function event(type, message) {
  recent.unshift({ at: new Date().toISOString(), type, message });
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
}

module.exports = {
  startedAt,
  counters,
  event,
  apiRequest() { counters.apiRequests += 1; },
  rpcCall() { counters.rpcCalls += 1; },
  rpcError(detail) { counters.rpcErrors += 1; event('rpc_error', detail); },
  snapshot() {
    return {
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      ...counters,
      recent: [...recent],
    };
  },
};
