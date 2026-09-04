# coturn 계획서 — 왜, 그리고 무엇을 정했는가

## ① 진단 — 모바일(셀룰러)만 통화가 안 되는 이유

`services/janus/`(WebRTC ↔ SIP 게이트웨이)의 NAT 통과 수단은 지금
**`nat_1_1_mapping` 하나뿐**입니다 — Janus 가 스스로 알고 있는 사설 주소를
`janus.jcfg` 의 `public_ip` 값으로 그대로 바꿔치기해 SDP·ICE 후보에 싣는
정적 1:1 매핑입니다. STUN 서버도 TURN 서버도 이 스택 어디에도 없습니다 —
저장소 전체에서 `turn_server` 를 찾아도 0건입니다 (2026-09-04 확인).

이 방식은 **LAN·같은 단지 WiFi 단말에는 아무 문제가 없습니다.** 그 단말들은
서버와 같은 `10.0.0.0/8` 사설망에 있어서, NAT 통과 자체가 필요 없기
때문입니다 — 사설 주소로 직접 붙습니다.

문제는 **셀룰러 데이터를 쓰는 모바일**입니다. 통신사 CGNAT(carrier-grade
NAT)은 흔히 symmetric·restrictive 성격이라, 매핑되는 외부 포트가 목적지마다
달라지거나 예측할 수 없습니다. 서버가 아무리 정확한 공인 IP 를 광고해도,
문제는 그 반대 방향입니다 — **단말 쪽에서 나가는 매핑을 서버가 미리 알 수
없다는 것**이죠. `nat_1_1_mapping` 은 서버 쪽 주소만 고쳐 줄 뿐, 이 문제를
전혀 건드리지 않습니다.

### 실제로 확인한 것 — "자기 공인 IP 를 모른다" 류의 문제가 아니다

`journalctl -u janus` 로 실패한 세션을 재현해 들여다본 결과, 실패한 클라이언트가
STUN 으로 스스로 알아낸 **srflx 후보(자기 공인 IP+포트)는 이미 정확했습니다.**
"클라이언트가 자기 공인 주소를 몰라서" 실패하는 흔한 원인이 아니었다는
뜻입니다 — 그 주소·포트를 상대(Janus)에게 정확히 알렸는데도 ICE 협상이
끝내 성립하지 않았습니다. 원인은 그 주소·포트로 되돌아오는 경로 자체가
통신사 NAT 정책(symmetric NAT 은 목적지마다 다른 외부 포트를 매핑합니다)에
막혀 있었다는 것입니다.

이런 경우를 뚫는 방법은 하나뿐입니다 — **TURN 릴레이.** 릴레이 자체가
공인 주소를 갖고 양쪽 트래픽을 중계하므로, 어느 쪽 NAT 정책과도 무관하게
"릴레이의 공인 주소로만 통신한다" 는 하나의 경로로 통일됩니다.

## ② 이 서비스가 하는 일 — coturn 을 세우는 것까지만

`services/coturn/` 은 coturn(TURN/STUN 서버 구현) 을 이 저장소의 다른
apt 패키지 데몬(Kamailio·rtpengine)과 같은 방식으로 들여옵니다 — 표준
Debian/Ubuntu 패키지, 배포판이 만드는 systemd 유닛, 우리는 `/etc/turnserver.conf`
와 `/etc/default/coturn` 의 활성화 플래그만 소유합니다.

**이 작업이 끝나도 아무것도 자동으로 좋아지지 않습니다.** coturn 이 떠
있다는 것과, Janus 와 모바일 앱이 그것을 실제로 쓴다는 것은 다른 일입니다.
④ 절에 다음 단계를 적어 둡니다.

## ③ 릴레이 포트 범위 — 49160-49560

이 장비에서 UDP 포트를 실제로 바인딩하는 프로세스가 이미 셋 있습니다.

| 범위 | 프로세스 | 어디서 정하나 |
|---|---|---|
| `20000-20200` | Janus WebRTC | `services/janus/settings.ini` 의 `rtp_port_range` |
| `30000-30200` | Janus SIP 쪽 | `services/janus/janus.plugin.sip.jcfg` |
| `10200-19999` | rtpengine/rtpproxy | `services/kamailio/settings.ini` 의 `media_port_range` |

coturn 의 릴레이 범위는 이 셋과 겹치지 않아야 합니다 — 넷 다 같은 장비에서
UDP 포트를 바인딩하는 서로 다른 프로세스이기 때문입니다. IANA 의 동적/사설
포트 구간(`49152-65535`) 안에서, 위 셋과 겹치지 않는 **`49160-49560`**
(400개)을 기본값으로 잡았습니다.

400개로 잡은 근거: coturn 은 통화 하나(음성+영상)당 보통 릴레이 후보를
1~2개 할당합니다. 이 단지 규모에서 **동시에 TURN 릴레이를 실제로 타는**
셀룰러 통화가 수백 건 겹칠 일은 없다고 보고, 여유를 넉넉히 둔 숫자입니다.
`services/coturn/install.sh` 의 `validate_settings` 가 세 범위를 실제로
읽어(하드코딩된 숫자가 아니라 각 서비스의 `settings.ini`/`.jcfg` 를 직접
읽습니다) 겹침을 다시 확인합니다 — 이 문서의 숫자가 낡아도 설치 시점에는
항상 실물과 비교됩니다.

## ④ 인증 — 공유 장기 자격 증명 대신 TURN REST API

`turnserver.conf` 에 자세히 적었지만 요약하면: 이 배치는 Janus 뒤의
**모든 모바일 단말**이 같은 TURN 서버를 씁니다. 장기 자격 증명(`lt-cred-mech`)
방식으로 하면 그 많은 단말에 계정 하나를 공유하게 되어, 하나가 유출되면
전부 새로 발급해야 합니다 — Janus 의 `api_secret` 이 이미 겪은 문제이고,
그래서 websocket-relay 가 단말마다 다른 토큰을 발급하는 방향으로 옮겨간
것과 같은 이유입니다 (`services/janus/README.md` 의 "단말 토큰" 절).

**TURN REST API**(`use-auth-secret` + `static-auth-secret`)는 계정 저장소
자체가 필요 없습니다. 사용자명은 "만료시각:임의값", 비밀번호는
`HMAC-SHA1(사용자명, static-auth-secret)` 을 그 자리에서 계산합니다. coturn
은 서명과 만료시각만 검증하면 되고, 자격 증명은 보통 통화 하나 분량의
시간만 유효해 유출 위험도 훨씬 작습니다.

`static_auth_secret` 은 **`settings-schema.json` 의 필드가 아닙니다.**
사람이 폼에 입력하는 값이 아니라 `install.sh --apply` 가
`openssl rand -hex 16` 로 생성해 `secrets/static-auth-secret` 에 두는
값입니다 — `services/janus` 의 `admin-secret`·`api-secret` 과 정확히
같은 자리입니다. 이 저장소의 관례를 그대로 따른 것입니다: 장비마다 다른
**설정값**은 `settings.ini`, 기계가 생성하는 **비밀**은 `secrets/`.

## ⑤ 공인 IP — Janus 의 값을 물려받는다

이 장비는 Janus 와 같은 회선·같은 공유기를 씁니다(같은 호스트입니다).
`public_ip` 를 `site/settings-schema.json` 으로 올려 여러 서비스가 공유하는
사이트 값으로 만드는 것이 원칙적으로 더 깔끔하지만, 지금 Janus 자신도 그
값을 사이트 층에서 읽지 않고 자기 `settings.ini` 를 직접 쓰는 유일한
값으로 두고 있습니다 (`services/janus/install.sh` 는 `lib/site.sh` 를
아예 불러오지 않습니다). 사이트 층을 새로 만들고 Janus 까지 그쪽으로
옮기는 것은 이 작업의 범위를 넘어선다고 판단해, **coturn 이 Janus 의
`settings.ini`/`.applied-settings` 를 직접 읽는** 최소 결합으로
같은 효과(값을 두 번 입력하지 않아도 되는 것)를 냅니다
(`services/coturn/install.sh` 의 `janus_public_ip()`).

이것은 판단이 갈릴 수 있는 자리입니다 — "아직 안 한 일" 절에 남겨 둡니다.

## ⑥ 대시보드가 CLI 를 쓰지 않는 이유

coturn 은 telnet 기반 관리 CLI(기본 5766)를 갖고 있고, 열면 활성 세션·
릴레이 할당 개수까지 볼 수 있습니다. 하지만 그 채널은 세션을 강제로 끊을
수도 있는 관리 채널이라, Janus 의 Admin API 와 같은 성격의 위험을 갖습니다.
`kamailio-dashboard` 가 설정을 바꾸지 않고 FIFO 로만 읽는 것과 같은
"읽기 전용 관찰자" 원칙을 지키기 위해, v1 에서는 CLI 를 아예 껐습니다
(`turnserver.conf` 의 `no-cli`). 대신 `systemctl is-active` 와
`journalctl` 만으로 "떠 있는가·최근 무엇이 있었는가" 를 봅니다. 세션 개수가
꼭 필요해지면 그때 CLI 를 열고 `cli-password` 를 잠그면 됩니다.

## ⑦ 릴레이 대상을 사설 대역에서 막지 않는다

공개 TURN 서비스라면 릴레이가 사설 대역(RFC1918)·루프백으로 나가지
못하게 막는 것이 SSRF 방지의 정석입니다. **이 배치는 전제가 다릅니다** —
릴레이가 최종적으로 패킷을 보낼 곳이 바로 Janus 이고, Janus 는 이 coturn
과 같은 사설망(`10.10.0.224`)에 있습니다. 사설 대역을 막으면 TURN 릴레이가
정작 Janus 에 닿지 못해 이 서비스를 만든 이유 자체가 사라집니다. 그래서
`denied-peer-ip` 를 사설 대역에 걸지 않습니다 — 자세한 근거는
`turnserver.conf` 의 주석에 있습니다.

---

## 아직 안 한 일 — coturn 이 떠 있어도 아무것도 안 씁니다

**이 저장소 작업은 coturn 을 세우는 것까지입니다.** 아래는 다음 단계이고,
전부 이 디렉토리 밖의 변경이 필요합니다.

1. **`services/janus/janus.jcfg` 의 `nat: {}` 블록에 TURN 을 추가.**
   Janus 의 SIP 플러그인이 만드는 PeerConnection 이 이 TURN 서버를 후보로
   쓰게 하려면 `turn_server` · `turn_port` · `turn_type`(udp/tcp/tls) ·
   `turn_user` · `turn_pwd` 를 채우거나, 시간제한 자격 증명을 쓰려면
   `turn_rest_api` · `turn_rest_api_key`(= 이 서비스의
   `static-auth-secret`) · `turn_rest_api_method` 를 채워야 합니다.
   후자가 이 작업에서 고른 인증 방식(④ 절)과 맞습니다.

2. **`services/janus/settings-schema.json` 에 대응하는 필드 추가.**
   1번의 값 중 장비마다 다른 것(`turn_server` 의 주소 등)은 이 저장소의
   설정 규약(`docs/settings-contract.md`)을 따라 폼 항목으로 노출해야
   합니다. 지금은 아무 필드도 없습니다.

3. **모바일 앱의 WebRTC `iceServers` 목록에 이 TURN 서버를 추가.**
   앱 소스는 이 저장소에 없습니다. 앱이 통화를 시작하기 전에 (a) 이
   TURN 서버의 주소·포트를 알아야 하고, (b) TURN REST API 자격 증명을
   직접 계산하거나(같은 `static-auth-secret` 을 앱에 심는 것은 다시
   장기 공유 비밀 문제로 돌아가므로 권장하지 않습니다) 서버 쪽(예:
   websocket-relay)이 계산해 앱에 내려줘야 합니다 — 이 계산기 자체가
   아직 어디에도 없습니다.

4. **④ 절에서 만든 `static-auth-secret` 을 실제로 계산에 쓰는 코드.**
   coturn 쪽 절반(비밀 생성·설정)은 이 작업이 끝냈지만, "만료시각:임의값"
   사용자명을 만들고 HMAC 을 계산해 앱에 내려주는 절반은 없습니다. 가장
   자연스러운 자리는 websocket-relay 입니다 — 이미 단말마다 다른 SIP
   계정과 Janus 토큰을 발급하는 곳이기 때문입니다(`docs/identity.md`).

5. **공인 IP 를 사이트 값으로 올릴지 결정.** ⑤ 절에서 미룬 판단입니다.
   Janus 도 함께 사이트 층으로 옮기는 리팩터링이 필요합니다.

6. **실제 셀룰러 단말로 재현 시험.** ①에서 관찰한 실패를 이 TURN 서버를
   경유해 재현·해소하는지 확인하는 절차가 없습니다 —
   `services/janus/verify-call.sh` 같은 자동 시험 스크립트를 만들거나,
   최소한 사람이 셀룰러 회선에서 손으로 걸어 보는 절차를 문서로 남겨야
   합니다.

이 목록이 비기 전까지는 **coturn 이 떠 있어도 지금 겪는 증상(셀룰러
모바일에서 통화가 안 되는 것)은 그대로입니다.**
