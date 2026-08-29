# SIP 계정 등록과 삭제

계정은 `kamailio` 데이터베이스의 `subscriber` 테이블에 있습니다.
`kamctl` 로 다루는 방법과 SQL 로 직접 다루는 방법 두 가지가 있고, 결과는 같습니다.

## 먼저 — 손으로 만들 것은 인터폰뿐입니다

| 무엇 | 번호 | 누가 만드나 |
|---|---|---|
| 모바일 | `<세대>01`~`04` | **websocket-relay** — 등록 승인 때 (`libs/enrollment.ts`) |
| 월패드 | `<세대>00` | **websocket-relay** — 월패드가 등록할 때 (`libs/homenetRecord.ts`) |
| 인터폰 | `<인터폰세대>00` — 예: `0101990100` (101동 9901호) | 사람 — 아래 절차 |
| 시험용 | `9999999901`~`04` | 사람 (9999동 9999호, 실재하지 않는 세대) |

번호 규격과 이유는 [docs/identity.md](../../docs/identity.md) 에 있습니다.
`<세대>` 는 동4자리 + 호4자리입니다 — 101동 805호면 `01010805`. 인터폰도 같은
규칙을 쓰되 실재하지 않는 호(`9901` 등)를 그 동에 두고 순번은 `00` 입니다.

비밀번호도 relay 가 발급하고, 단말은 등록 응답의 `sip` 로 받아 갑니다. 그래서
모바일·월패드 계정을 `kamctl` 로 만들면 **relay 가 다음 등록 때 덮어씁니다.**
아래 절차는 인터폰과 시험용 계정에 쓰세요.

만들어진 계정이 **등록될 수 있는 모양인지**는 아래로 봅니다 (sudo 불필요).

```bash
./check-accounts.sh          # 계정 목록 · 도메인 어긋남 · 비밀번호 빈 계정
./check-accounts.sh --json   # 구축 마법사가 읽는 형식
```

## kamctl 로 (권장)

> **반드시 절대경로 `/usr/sbin/kamctl` 을 쓰세요.**
> `PATH` 의 `kamctl` 은 `/usr/local/sbin` 의 소스빌드 5.7.7 판이고, 그쪽은
> `/usr/local/etc/kamailio/kamctlrc` 를 읽습니다. 구동 중인 것은 패키지판 5.5.4 입니다.

```bash
sudo /usr/sbin/kamctl add 1001 '내선1001비밀번호'    # 등록
sudo /usr/sbin/kamctl passwd 1001 '새비밀번호'       # 비밀번호 변경
sudo /usr/sbin/kamctl rm 1001                        # 삭제
sudo /usr/sbin/kamctl show                           # 전체 목록
sudo /usr/sbin/kamctl ul show                        # 현재 등록(온라인)된 단말
```

도메인은 `kamctlrc` 의 `SIP_DOMAIN` 이 붙습니다.

## 비밀번호 길이 — Kamailio 는 제한하지 않는다

**Kamailio 쪽에는 최소 길이 규칙이 없습니다.** `subscriber.password` 는
`varchar(64) NOT NULL` 이고, digest 인증은 그 문자열로 MD5 를 계산할 뿐입니다.
한 글자짜리 비밀번호도 인증 자체는 성립합니다.

| 어디서 오는 제한 | 값 | 성격 |
|---|---|---|
| 대시보드 최소 길이 | **4자** | 우리가 정한 정책. `server/src/subscribers.js` 에서 바꿀 수 있다 |
| 대시보드 최대 길이 | **64자** | 정책이 아니라 컬럼 크기. 넘기면 `STRICT_TRANS_TABLES` 라 INSERT 가 실패한다 |
| `kamctl add` | 없음 | 무엇이든 넣는다 |

숫자를 바꾸려면 `MIN_PASSWORD_LENGTH` 한 곳만 고치면 됩니다 — API 가 그 값을
화면에 내려 주므로 프런트에 같은 숫자가 박혀 있지 않습니다.

## ⚠️ 어느 컬럼이 실제로 인증에 쓰이는가

이 서버의 `kamailio.cfg` 는 아래와 같습니다.

```
modparam("auth_db", "calculate_ha1", yes)
modparam("auth_db", "password_column", "password")
modparam("auth_db", "use_domain", 0)
```

따라서 **`auth_db` 는 평문 `password` 컬럼만 읽어, 요청에 담긴 realm 으로 ha1 을 그때그때 계산합니다.**
`ha1` / `ha1b` 컬럼과 `domain` 컬럼은 **조회에도 검증에도 쓰이지 않습니다.** (실측 확인)

| `password` 컬럼 | `ha1` 컬럼 | 결과 |
|---|---|---|
| 값 있음 | 무엇이든 | **인증 성공** |
| 비어 있음 | 값 있음 | **401 — 어떤 비밀번호로도 실패** |

그래서 `kamctlrc` 의 `STORE_PLAINTEXT_PW` 는 반드시 **`1`** 이어야 합니다.
`0` 으로 두면 `kamctl add` 가 해시만 남겨, 그 계정은 로그인할 수 없습니다.

realm 은 단말이 보낸 `From` 헤더의 도메인이 그대로 쓰입니다. DNS 조회는 하지 않으므로
`pluto.org` 처럼 실재하지 않는 이름도 됩니다. `subscriber.domain` 과 달라도 상관없습니다.

> 평문 저장이 꺼려지면 `calculate_ha1` 을 끄고 `ha1` 컬럼을 쓰는 방식으로 바꿀 수 있습니다.
> 배포판 설정을 고치지 않고 `/etc/default/kamailio` 의 `CFGFILE` 을 래퍼로 돌리면 됩니다.
> 다만 그 경우 `ha1` 이 특정 realm 에 묶이므로, `subscriber.domain` 이 단말이 보내는
> `From` 도메인과 정확히 같아야 합니다.

## SQL 로 직접

`ha1` 은 `MD5(username:realm:password)` 이고 realm 은 SIP 도메인입니다.
`ha1b` 는 `MD5(username@domain:realm:password)` 로, 일부 단말이 이 형식을 씁니다.

```sql
-- 등록. password 컬럼을 반드시 채운다 (이 설정에서 인증에 쓰이는 값).
INSERT INTO subscriber (username, domain, password, ha1, ha1b) VALUES (
  '1001', '192.168.0.252', '내선1001비밀번호',
  MD5('1001:192.168.0.252:내선1001비밀번호'),
  MD5('1001@192.168.0.252:192.168.0.252:내선1001비밀번호')
);

-- 비밀번호 변경
UPDATE subscriber
   SET password = '새비밀번호',
       ha1  = MD5(CONCAT(username, ':', domain, ':', '새비밀번호')),
       ha1b = MD5(CONCAT(username, '@', domain, ':', domain, ':', '새비밀번호'))
 WHERE username = '1001' AND domain = '192.168.0.252';

-- 인증 불가 계정 찾기 (해시만 있고 평문이 없는 것)
SELECT id, username, domain FROM subscriber WHERE password = '';

-- 삭제
DELETE FROM subscriber WHERE username = '1001' AND domain = '192.168.0.252';

-- 목록 (해시는 빼고)
SELECT id, username, domain FROM subscriber ORDER BY username;
```

변경은 즉시 반영됩니다. `auth_db` 는 매 요청마다 조회하므로 Kamailio 를 재시작할 필요가 없습니다.

## ws-bridge 에서 다루려면

`database.ini` 의 `[user:jyahn]` 에 `kamailio` 를 넣어 두었으므로, 다른 서비스 스키마와
같은 계정으로 접근할 수 있습니다. manager 의 `server/src/db.js` 와 같은 방식으로 풀을 만들면
됩니다. (ws-bridge 는 아직 MariaDB 에 붙지 않습니다 — 붙일 때 추가하세요)

```js
// 비밀번호는 database/secrets/jyahn.pw 에서 읽는다. 코드나 설정 파일에 두지 않는다.
const pool = mysql.createPool({
  host: '127.0.0.1', user: 'jyahn', password: readSecret('jyahn.pw'),
  database: 'kamailio', connectionLimit: 5,
});
```

계정을 만들 때는 위 SQL 과 같은 방식으로 `ha1`/`ha1b` 를 계산해 넣습니다.
평문 비밀번호는 저장하지 마세요 — digest 인증에는 해시만 있으면 됩니다.

> 다만 `jyahn` 은 `host = %` 라서 LAN 어디서든 접속할 수 있고, 지금 MariaDB 는
> `0.0.0.0:3306` 에 열려 있습니다. SIP 계정 해시까지 그 범위에 들어오므로,
> 계정을 넣기 전에 `jyahn` 의 비밀번호를 강한 값으로 바꾸고 `host` 를 좁히는 편이 좋습니다.
> 자세한 내용은 이 디렉토리의 `README.md` 마지막 절을 보세요.

## 확인

```bash
# 인증이 걸려 있는지 — 등록되지 않은 사용자로 REGISTER 하면 401 이 와야 한다
sudo /usr/sbin/kamctl ul show

# ws-bridge 쪽 동작
pm2 logs ws-bridge --lines 30
```

WS 클라이언트는 `register` 메시지에 `password` 를 담아 보냅니다.
자세한 내용은 `../ws-bridge/README.md` 의 "SIP digest 인증" 절을 참고하세요.
