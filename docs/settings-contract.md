# 설정 규약 — `settings-schema.json`

**장비마다 다른 값**을 서비스가 어떻게 선언하고, 화면이 그것을 어떻게 받아
적는지에 대한 규약입니다.

구현은 [`lib/settings.js`](../lib/settings.js) 하나에 모여 있습니다.
관련: [setup-wizard.md](setup-wizard.md) · [check-contract.md](check-contract.md)

## 왜 필요한가 — 값을 받는 화면이 둘이 됐습니다

공인 IP·포트 범위·SIP 도메인 같은 값은 장비마다 다릅니다. 사람이 설정 파일을
직접 고치게 두면 자리표시자나 따옴표를 놓치기 쉽고, **틀려도 조용히 무음이 될 뿐
오류가 뜨지 않습니다.** 그래서 값만 따로 받는 화면을 janus 에 먼저 만들었습니다.

그다음 구축 마법사(`/manager/setup`)가 같은 값을 받게 되면서 화면이 둘이
됐습니다. 둘이 각자 항목 정의를 들고 있으면 언젠가 어긋납니다. 그래서 정의를
**서비스 디렉터리의 데이터 파일**로 내리고, 읽고 쓰고 검증하는 코드를 한 곳에
뒀습니다.

```
services/<서비스>/
├── settings-schema.json   항목 정의 — 커밋한다 (이것이 규약)
├── settings.ini           값 — 커밋하지 않는다 (장비마다 다르다)
└── .applied-settings      --apply 가 마지막으로 설치한 값 (root 가 쓴다)
```

**`services/` 아래일 필요는 없습니다.** 세 파일이 한 디렉터리에 같이 있고
`settings-schema.json` 이 규약대로면 됩니다. `nginx/public_ca/` 가 그렇습니다 —
공인 인증서의 도메인은 서비스가 아니라 서버 전체의 값입니다.

## 세 파일이 각각 다른 것을 뜻합니다

| 파일 | 누가 쓰는가 | 무엇을 뜻하는가 |
|---|---|---|
| `settings-schema.json` | 사람 (커밋) | **무엇을 받을 것인가** |
| `settings.ini` | 화면 · 편집기 | **사람이 정한 값** |
| `.applied-settings` | `--apply` (root) | **실제로 설치된 값** |

뒤의 둘이 다르면 "저장은 됐지만 아직 반영 안 됨" 입니다. 점검 스크립트가 그것을
`pending` 으로 보고하고, 마법사의 단계는 통과하지 않습니다 — **값을 적어 넣은
것과 반영한 것은 다르기 때문입니다.**

`.applied-settings` 가 아예 없으면 비교할 대상이 없습니다. 그때는 "다르다" 가
아니라 **"모른다"** 이므로 대기로 보고하지 않습니다. 없는 것을 근거로 "아직
반영 안 됨" 이라고 말하면 늘 거짓 경보가 됩니다.

## 스키마

```json
{
  "service": "kamailio",
  "applyCommand": "sudo ./install.sh --apply",
  "settingsFile": "settings.ini",
  "appliedFile": ".applied-settings",
  "fields": [
    {
      "key": "sip_listen_addr",
      "label": "SIP 를 받을 주소",
      "help": "이 장비의 LAN 주소입니다. 장비마다 다르므로 기본값이 없습니다.",
      "placeholder": "192.168.0.252",
      "optional": false,
      "type": "ipv4",
      "pattern": "^\\d{1,3}(\\.\\d{1,3}){3}$",
      "patternHint": "IPv4 (예: 192.168.0.252)",
      "effect": "kamailio-local.cfg 의 listen=udp/tcp:<주소>:5060 이 됩니다. …"
    }
  ]
}
```

| 항목 | 뜻 |
|---|---|
| `key` | `settings.ini` 의 키. 영문·숫자·`_` 만 |
| `label` · `help` · `placeholder` | 화면이 그대로 씁니다 |
| `optional` | 비워 둘 수 있는가 |
| `default` | 비어 있을 때 스크립트가 쓸 값 (선택) |
| `type` | `text` · `ipv4` · `port_range` — 아래 |
| `pattern` · `patternHint` | 형식과, 틀렸을 때 사람에게 보여 줄 말 |
| `conflicts` | `port_range` 전용. 겹치면 안 되는 범위들 |
| `effect` | **이 값이 어디로 흘러가는가.** 화면이 입력칸 밑에 보여 줍니다 |

`effect` 를 빼지 마세요. 사람이 값을 넣을 때 가장 알고 싶은 것은 "이걸 바꾸면
무엇이 달라지나" 입니다.

### `type` 이 더해 주는 검사

| `type` | 형식 말고 더 보는 것 |
|---|---|
| `text` | 없음 (`pattern` 만) |
| `ipv4` | 각 자리가 255 이하인가 |
| `port_range` | 시작 < 끝, 1024~65535, `conflicts` 와 겹치지 않는가 |

**규칙은 전부 데이터입니다.** `lib/settings.js` 에 서비스 이름이나 키 이름을
박지 않습니다 — 그러면 설정을 하나 늘릴 때마다 공용 코드를 고쳐야 합니다.

## 검증은 두 번 합니다

```
화면(lib/settings.js) ──저장──▶ settings.ini ──읽기──▶ --apply (root)
        ①                                                  ②
```

① 은 사람이 오타를 냈을 때 **즉시** 알려 주기 위해서고, ② 는 화면을 우회해
파일을 손으로 고쳤을 때를 막기 위해서입니다. 둘 다 통과해야 설치됩니다.

### ⚠️ 화면이 볼 수 없는 것은 스크립트가 봅니다

형식이 맞는다고 쓸 수 있는 값은 아닙니다.

```
sip_listen_addr = 10.9.9.9      ← IPv4 로는 멀쩡하다
```

이 주소가 **이 장비에 없으면** Kamailio 는 바인딩에 실패해 죽습니다. 문법
검사(`kamailio -c`)도 통과하므로 재시작에서야 드러납니다. 이런 검사는 장비를
아는 쪽, 즉 그 서비스의 스크립트가 합니다 (`install.sh` 의 `validate_settings`).

**형식은 화면이, 현실은 스크립트가 봅니다.** 스키마에 "이 장비에 있는 주소" 같은
규칙을 넣으려 하지 마세요.

## 스크립트에 붙이는 법

```bash
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"
APPLIED_FILE="${SCRIPT_DIR}/.applied-settings"

# 절(section)은 쓰지 않는다 — node 쪽(lib/settings.js)도 같은 파일을 파싱한다.
settings_get() {
    local key="$1" fallback="${2:-}" v=""
    if [[ -r "$SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
    fi
    v="${v//[[:space:]]/}"
    echo "${v:-$fallback}"
}

SIP_DOMAIN="$(settings_get sip_domain 'pluto.org')"
```

그리고 `--apply` 가 **성공한 뒤에** 무엇을 설치했는지 남깁니다.

```bash
{
    echo "; install.sh --apply 가 마지막으로 설치한 값. 손으로 고치지 마세요."
    echo "sip_domain = ${SIP_DOMAIN}"
} > "$APPLIED_FILE"
chmod 644 "$APPLIED_FILE"
```

**되돌린 경우에는 남기지 않습니다** — 그때 설치돼 있는 것은 옛 값입니다.

## 지켜야 할 것

- **기본값을 함부로 두지 마세요.** 한 장비의 값을 다른 장비가 물려받을 수 없는
  것(예: LAN 주소)은 기본값 없이 두고, 없으면 `pending` 으로 보고합니다.
  `sip_listen_addr` 이 그렇습니다.
- **`settings.ini` 를 커밋하지 마세요.** `.gitignore` 에 `settings.ini` 와
  `.applied-settings` 를 넣습니다. 스키마는 커밋합니다.
- **화면은 sudo 를 부르지 않습니다.** 값을 적을 뿐이고 반영은 사람이 합니다.
- **점검에 "아직 반영 안 됨" 을 넣으세요.** 그것이 없으면 값을 입력한 사람이
  적용했다고 착각한 채 다음으로 넘어갑니다.

## 붙인 곳

| 서비스 | 항목 | 읽는 스크립트 |
|---|---|---|
| `services/janus` | `public_ip` · `rtp_port_range` | `install.sh` |
| `services/kamailio` | `sip_domain` · `sip_listen_addr` · `sip_push_url` | `install.sh` |
| `nginx/public_ca` | `domain` · `email` | `setup_letsencrypt.sh` · `cert-status.sh` · `renew-status.sh` |

`websocket-relay` 는 아직 없습니다 — 자기 `.env` 로 값을 받고 있고, 13단계
어디에서도 파라미터를 묻지 않기 때문입니다. 필요해지면 같은 모양으로 붙입니다.
