# `/health` 규약

모든 서비스는 `/health` 에 **같은 형태**로 응답합니다.
manager 대시보드는 이 형태만 알면 되고, 서비스가 늘어나도 대시보드를 고칠 필요가 없습니다.

## 응답

```json
{
  "service":   "huygens-server",
  "status":    "ok",
  "version":   "1.0.0",
  "uptimeSec": 1234,
  "pid":       4321,
  "timestamp": "2026-08-18T02:08:19.815Z",
  "details":   { }
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `service` | ✅ | 서비스 이름. `nginx-conf/service.ini` 의 `[service] name` 과 같아야 합니다 |
| `status` | ✅ | 아래 표 참고 |
| `version` | | 서비스 버전. 보통 `package.json` 의 `version` |
| `uptimeSec` | | 프로세스가 뜬 뒤 흐른 초 |
| `pid` | | 프로세스 ID |
| `timestamp` | ✅ | 응답을 만든 시각 (ISO 8601) |
| `details` | | 서비스마다 다른 자유 형식. 대시보드는 상세 보기에서 그대로 펼쳐 보여줍니다 |

서비스 고유의 정보(DB 연결 상태, 모델 이름, 큐 길이 …)는 **`details` 안에** 넣습니다.
최상위에 새 필드를 만들지 마세요 — 대시보드가 무시합니다.

## `status` 값

| 값 | 뜻 | HTTP |
|---|---|---|
| `ok` | 정상 | 200 |
| `degraded` | 떠 있지만 온전하지 않음 (예: 빌드 결과 없음, 선택적 의존성 끊김) | 503 |
| `error` | 핵심 의존성이 끊겨 요청을 처리할 수 없음 | 503 |

manager 는 하위 호환을 위해 `healthy` / `up` / `pass` / `ready` / `green` 도 정상으로 받아들이지만,
새로 만드는 서비스는 `ok` 를 쓰세요.

## 대시보드의 판정

| 표시 | 조건 |
|---|---|
| 정상 (up) | 2xx 응답이고 `status` 가 정상 값 (또는 `status` 필드가 없음) |
| 주의 (degraded) | 2xx 응답이지만 `status` 가 정상 값이 아님 |
| 중단 (down) | 연결 실패 / 타임아웃 / 2xx 아닌 응답 |
| 알 수 없음 (unknown) | 헬스 URL 을 만들 수 없음 |

> `degraded` 와 `error` 에 503 을 쓰면 대시보드에는 **중단(down)** 으로 잡힙니다.
> "떠 있지만 이상함" 을 주의(degraded) 로 보이고 싶으면 200 + `status: "degraded"` 로 응답하세요.
> 로드밸런서에서 빼고 싶을 때만 503 을 씁니다.

## 지켜야 할 것

1. **인증 없이** 응답해야 합니다. manager 는 루프백에서 인증 없이 호출합니다.
2. **IP 제한보다 앞에** 두세요. 미들웨어 순서상 뒤에 있으면 loopback 호출이 403 으로 막힙니다.
   (`apartment-mgmt-server` 는 `app.get('/health')` 를 IP 허용목록 미들웨어 **위에** 둡니다)
3. **가벼워야 합니다.** 대시보드는 기본 5초마다 호출합니다. 무거운 점검은 `details` 에 캐시된 값을 쓰세요.
4. 경로는 기본 `/health` 입니다. 다르면 `nginx-conf/service.ini` 의 `health_path` 로 알립니다.

## 최소 구현 예

Node:

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

Flask:

```python
STARTED_AT = time.time()

@app.route('/health')
def health_check():
    return jsonify({
        "service": "my-service",
        "status": "ok",
        "version": "2.0",
        "uptimeSec": int(time.time() - STARTED_AT),
        "pid": os.getpid(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "details": {},
    }), 200
```

## 현재 상태

| 서비스 | 경로 | 비고 |
|---|---|---|
| `nginx-manager` | `/health` | ✅ 규약대로 |
| `web-cassini` | `/health` | ✅ 규약대로. `dist` 가 없으면 `degraded` |
| `huygens-server` | `/health` | ✅ 규약대로. `details` 에 DB·클러스터 상태 |
| `face-recognition-server` | `/health`, `/api/v2/health` | ✅ 규약대로. 기존 필드는 `details` 로 옮김 |
| `websocket-relay` | `/health` | ✅ 규약대로. `details` 에 룸·연결 수, 푸시 사용 여부 |
