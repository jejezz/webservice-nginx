# 대안 — Asterisk 를 다시 검토하게 될 때

지금은 Kamailio 로 갑니다. 이 문서는 **판단을 미뤄 둔 것**을 기록해, 나중에
다시 저울질할 때 처음부터 조사하지 않아도 되게 하려는 것입니다.

관련: [websocket-plan.md](websocket-plan.md) · [incoming-call.md](incoming-call.md)

## 왜 Kamailio 를 유지하는가

가장 큰 이유는 **설정을 완전히 소유한다**는 점입니다.

오늘 착신 푸시를 넣을 때 배포판 `kamailio.cfg` 가 `route[LOCATION]` 과
`route[REGISTRAR]` 을 소유하고 `#!define` 이라는 미리 예상된 훅만 열어 준다는
벽에 부딪혔습니다. 그런데 **빠져나올 수 있었습니다** — 설정을 포크해서 원하는
자리에 코드를 넣었고, 원본에서 줄 하나 지우지 않은 채 변경 지점 두 곳만
표시했습니다.

프레임워크가 설정을 생성하는 방식(FreePBX 가 그렇습니다)에서는 그게 안 됩니다.
GUI 가 다음 저장 때 덮어씁니다. 그 차이가 이 프로젝트에서는 결정적입니다.

## FreePBX 는 후보가 아닙니다

- dialplan 을 **생성**하고, 사용자는 `extensions_custom.conf` 의 정해진
  훅(`[from-internal-custom]` 등)에만 끼어들 수 있습니다. 그들이 예상하지 않은
  동작을 원하면 프레임워크와 싸웁니다.
- "free" 는 프레임워크에 붙는 말입니다. 쓸 만한 것들(Class of Service, 녹취
  리포트, EndPoint Manager 전체 기능, HA 등)은 Sangoma 상용 모듈입니다.
- PHP + 웹서버 + MySQL + Asterisk 스택 자체가 가볍지 않습니다.

## 맨 Asterisk 는 여전히 후보입니다

FreePBX 를 빼고 보면 위 문제들이 사라집니다 — GUI 없음, dialplan 전부 사용자 것,
상용 모듈 없음.

### 흔한 오해 두 가지

**"Asterisk 는 설정 파일로만 단말 정보를 읽는다"** — 기본은 그렇지만 아닙니다.

**ARA (Asterisk Realtime Architecture)** 로 PJSIP 객체를 DB 에 둘 수 있습니다.

```
# extconfig.conf
[settings]
ps_endpoints  => odbc,asterisk
ps_auths      => odbc,asterisk
ps_aors       => odbc,asterisk
ps_contacts   => odbc,asterisk
```

`sorcery.conf` 가 객체별로 "설정 파일에서 읽을지 DB 에서 읽을지" 를 정하고,
`res_odbc.conf` 가 접속 정보를 갖습니다. Asterisk 가 Alembic 마이그레이션을
함께 배포하므로 스키마를 손으로 만들 필요도 없습니다.

> 이 축에서는 **Kamailio 도 이미 같은 자리**입니다. 계정을 `subscriber` 테이블에
> 두고 있고, 대시보드가 그것을 읽고 씁니다. DB 지원 여부는 둘을 가르는
> 기준이 아닙니다.

**"온갖 설정 파일로 dialplan 을 만들어야 한다"** — 그것도 피할 수 있습니다.

**ARI (Asterisk REST Interface)** 를 쓰면 dialplan 이 한 줄로 줄고 통화 로직이
**우리 코드**로 옵니다.

```
; extensions.conf — 이게 전부다
exten => _X.,1,Stasis(callfusion)
```

채널이 `Stasis()` 에 들어가는 순간 dialplan 에서 빠져나와, WebSocket 으로
연결된 앱이 REST 로 채널·브리지·미디어를 조작합니다. 이벤트는 JSON 으로
옵니다.

이 프로젝트와 잘 맞는 부분이 있습니다 — 이미 Node 서비스와 MariaDB, 대시보드가
있으므로 통화 로직이 **테스트 가능한 JavaScript** 로 들어옵니다. 설정 DSL 을
읽을 줄 몰라도 코드를 읽을 수 있는 사람이 손댈 수 있습니다.

Kamailio 에는 대응물이 마땅치 않습니다. `evapi` 가 가장 가깝지만 훨씬
저수준이고, 라우팅 결정 자체는 여전히 `kamailio.cfg` 안에 있습니다.

### 실제로 갈리는 지점 — 미디어

| | Kamailio (현재) | Asterisk |
|---|---|---|
| 시그널링 | ✅ 완료 | 다시 구성 |
| 미디어 | ❌ **rtpengine 별도** | 내장 |
| WebRTC | rtpengine 에 ICE/DTLS/SRTP 플래그 직접 | `webrtc=yes` (chan_pjsip) |
| 계정 저장 | DB (`subscriber`) | DB (ARA) 또는 파일 |
| 통화 로직 | `kamailio.cfg` (설정 DSL) | dialplan 또는 **ARI (우리 코드)** |
| 설정 소유권 | 완전 | 완전 |
| 규모 | 수만 동시 등록 | 수백 |

**남은 작업이 정확히 저 차이에 걸려 있습니다.** rtpengine 조달(배포판 저장소에
없음), 공인 IP 광고, `30000-30500/udp` 포워딩, H.264 파라미터 정렬 — Asterisk
였다면 상당 부분이 `webrtc=yes` 뒤로 숨었을 것들입니다.

### 대가

- **ARA**: 조회마다 DB 쿼리가 붙습니다. 캐싱 동작을 이해해야 하고, 모든 것이
  realtime 이 되지는 않습니다. **dialplan 을 DB 에 두는 것은 권장되지
  않습니다** — 단말(endpoint)은 DB, dialplan 은 파일이나 ARI 가 보통입니다.
- **ARI**: 통화 상태 기계를 우리가 소유하게 됩니다. 코드가 늘고, WebSocket
  재접속·중복 이벤트를 직접 다뤄야 합니다. 편해지는 게 아니라 **옮겨지는** 것입니다.
- **전환 비용**: 오늘 만든 시그널링(WS 전송, alias, 인증, tsilo 착신 사슬)을
  다시 만들어야 합니다.

## 언제 다시 볼 것인가

**rtpengine 작업을 시작하기 직전**이 그 자리입니다.

지금 상태는 판단을 미뤄 두기 좋습니다 — 인터폰끼리 통화는 미디어가 서버를
거치지 않고 직접 흐르므로 rtpengine 없이도 됩니다. 모바일과의 미디어를 붙일
때가 결정 시점입니다.

그때 물어볼 것:

1. rtpengine 조달·운영(공인 IP 추적 포함)이 감당할 만한가
2. 통화 로직이 앞으로 더 복잡해질 것인가 (전환·대기·다자 통화 등)
   — 그렇다면 ARI 쪽 이점이 커집니다
3. 지금 Kamailio 설정을 유지·이해할 사람이 있는가

1·2 가 부담스럽고 3 이 불안하면 Asterisk + ARI 를 다시 볼 만합니다.
반대로 지금처럼 인터폰↔모바일 1:1 통화가 전부라면, 이미 동작하는 것을
갈아엎을 이유가 없습니다.

## 참고

- [Setting up PJSIP Realtime — Asterisk Documentation](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Setting-up-PJSIP-Realtime/)
- [Realtime Database Configuration — Asterisk Documentation](https://docs.asterisk.org/Fundamentals/Asterisk-Configuration/Database-Support-Configuration/Realtime-Database-Configuration/)
- [Asterisk REST Interface (ARI) — Overview](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/)
- [Stasis Improvements: Goodbye Dialplan!](https://www.asterisk.org/stasis-improvements-goodbye-dialplan/)
