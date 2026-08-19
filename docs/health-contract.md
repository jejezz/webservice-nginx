# `/health` 규약

모든 서비스는 `/health` 에 **같은 형태**로 응답합니다.
manager 대시보드는 이 형태만 알면 되고, 서비스가 늘어나도 대시보드를 고칠 필요가
없습니다. 대시보드는 Nginx 를 거치지 않고 루프백으로 직접 호출합니다.

## 응답

```json
{
  "service":   "ws-bridge",
  "status":    "ok",
  "version":   "1.0.0",
  "uptimeSec": 1234,
  "pid":       4321,
  "timestamp": "2026-08-18T10:23:45.797Z",
  "details":   { }
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `service` | ✅ | 서비스 이름. `nginx-conf/service.ini` 의 `[service] name`, `pm2-conf/app.ini` 의 `[app] name` 과 같아야 합니다 |
| `status` | ✅ | 아래 표 참고 |
| `version` | | 보통 `package.json` 의 `version` |
| `uptimeSec` | | 프로세스가 뜬 뒤 흐른 **초** |
| `pid` | | 프로세스 ID |
| `timestamp` | ✅ | 응답을 만든 시각 (ISO 8601) |
| `details` | | 서비스마다 다른 자유 형식. 대시보드가 상세 보기에서 그대로 펼칩니다 |

서비스 고유의 정보(DB 연결 상태, 세션 수, 큐 길이 …)는 **`details` 안에** 넣습니다.
최상위에 새 필드를 만들지 마세요 — 대시보드가 무시합니다.

## `status` 값

| 값 | 뜻 | HTTP |
|---|---|---|
| `ok` | 정상 | 200 |
| `degraded` | 떠 있지만 온전하지 않음 (선택적 의존성 끊김, 빌드 결과 없음 등) | 200 |
| `error` | 핵심 의존성이 끊겨 요청을 처리할 수 없음 | 503 |

manager 는 하위 호환을 위해 `healthy` / `up` / `pass` / `ready` / `green` 도 정상으로
받아들이지만, 새로 만드는 서비스는 `ok` 를 쓰세요.

## 대시보드의 판정

| 표시 | 조건 |
|---|---|
| 정상 | 2xx 이고 `status` 가 정상 값 (또는 `status` 필드 없음) |
| 주의 | 2xx 이지만 `status` 가 정상 값이 아님 |
| 중단 | 연결 실패 / 타임아웃 / 2xx 아닌 응답 |

> `degraded` 에 503 을 쓰면 대시보드에는 **중단**으로 잡힙니다.
> "떠 있지만 이상함" 을 주의로 보이고 싶으면 200 + `status: "degraded"` 로 응답하세요.
> 503 은 로드밸런서에서 빼고 싶을 때만 씁니다.

## 헬스 URL 이 정해지는 순서

구조 변경 후에는 다음 순서가 됩니다. (지금은 2번이 `nginx.ini` 라우트입니다)

1. `pm2-conf/app.ini` 의 `[env] HEALTH_URL` — 자체 HTTPS 서비스처럼 직접 지정할 때
2. `nginx-conf/service.ini` 의 `[service] host` + `ports` + `health_path`
3. `pm2-conf/app.ini` 의 `[env] PORT` → `http://127.0.0.1:<PORT>/health`

자체 서명 인증서로 HTTPS 를 제공하는 서비스는 `[env] HEALTH_INSECURE_TLS = true`
를 함께 지정해 검증을 건너뛰게 합니다.

## 지켜야 할 것

1. **인증 없이** 응답해야 합니다. manager 는 루프백에서 인증 없이 호출합니다.
2. **IP 제한·인증 미들웨어보다 앞에** 두세요. 뒤에 있으면 루프백 호출이 403 으로 막힙니다.
3. **가벼워야 합니다.** 대시보드가 주기적으로 호출합니다. 무거운 점검은 `details` 에
   캐시된 값을 쓰세요.
4. 경로는 기본 `/health` 입니다. 다르면 `nginx-conf/service.ini` 의 `health_path` 로 알립니다.

## 현재 상태

2026-08-18 루프백 직접 호출로 확인한 결과입니다.

| 서비스 | 포트 | 결과 |
|---|---|---|
| `route-a` `route-b` `route-c` | 28080·28081·28082 | ✅ 규약대로 |
| `ws-bridge` | 28083 | ✅ 규약대로. `details` 에 세션·연결 수, 프로토콜 |
| `manager` | 28084 | ✅ 규약대로 |
| `rtc-relay-server` | 28099 (자체 HTTPS) | ✅ 규약대로. `details` 에 방 수와 DB 상태 |
| `stock-analyzer` | 28085 | ⚠️ 최상위에 `db`, `uptime` 이 더 있음 → `details` 로 옮길 것 |

⚠️ 위 한 건은 지금도 대시보드에서 **정상으로 잡힙니다.** 하위 호환 값과 누락 필드를
너그럽게 받기 때문입니다. 구조 변경과 별개로 정리하면 좋은 항목이지, 마이그레이션의
전제 조건은 아닙니다.

## 최소 구현

```js
const startedAt = Date.now();

app.get('/health', (req, res) => {
  res.status(200).json({
    service: 'my-service',
    status: 'ok',
    version: pkg.version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
    timestamp: new Date().toISOString(),
    details: {},
  });
});
```
