#!/usr/bin/env bash
#
# 사이트 값 — **여러 서비스가 함께 쓰는 것들**을 한 곳에서 받는다.
#
#   ./site/apply.sh              지금 상태를 본다 (아무것도 바꾸지 않는다)
#   ./site/apply.sh --check --json   구축 마법사용 (docs/check-contract.md)
#   ./site/apply.sh --apply      값을 반영한다 (릴레이 재시작 · sudo 불필요)
#
# ── 왜 서비스 위에 층이 하나 더 있나 ────────────────────────────
# 설정 규약(docs/settings-contract.md)의 단위는 서비스 하나였다. 그래서 여럿이
# 공유하는 값을 둘 자리가 없었고, 각자 자기 파일에 베껴 적었다.
#
# 그 대가를 실제로 치렀다. 앱에게 알려 줄 Janus 주소가 릴레이 .env 에는
# 개발용 호스트로, 진짜 주소는 tools/directory.json 에 따로 적혀 있었다. 둘이
# 어긋나도 서버는 멀쩡히 돌고 로그도 조용했다 — 단말에서 이름이 풀리지 않아
# 통화가 안 된다는 것을 앱 쪽에서 알려 줄 때까지 몰랐다.
#
# `SIP_DOMAIN` 도 같은 병이다. kamctlrc 와 릴레이 .env 두 곳에 있고, 문서에
# "같아야 한다" 고 적어 둔 것이 곧 증상이다.
#
# ── 무엇을 여기 두고 무엇을 안 두나 ─────────────────────────────
# **둘 이상이 쓰는 값만** 여기 둔다. 한 서비스만 쓰는 것은 그 서비스의
# settings.ini 에 그대로 둔다 (janus 의 미디어 포트 범위 같은 것).
#
# ── 왜 DB 가 아닌가 ─────────────────────────────────────────────
# nginx · Kamailio · Janus 셋은 systemd 가 띄우고 **시작할 때 파일을 읽는다.**
# DB 를 읽을 방법이 없다. DB 에 두면 결국 "DB 를 읽어 파일을 만드는 도구" 가
# 필요한데, 그건 이미 각 서비스의 install.sh 가 하는 일이다. 게다가 DB 자체가
# 설정된 대상이라(database.ini) 설정의 출처가 설정을 필요로 하게 된다.
#
# DB 는 **런타임 상태**를 맡는다 — 등록된 단말·SIP 계정·승인 대기. 지금도
# 그렇게 쓰고 있고, 그 경계가 맞다.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SETTINGS="${SCRIPT_DIR}/settings.ini"
APPLIED="${SCRIPT_DIR}/.applied-settings"
DIRECTORY="${REPO_ROOT}/services/websocket-relay/tools/directory.json"

source "${REPO_ROOT}/lib/check-report.sh"
check_init "site.settings"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

MODE="check"
for a in "$@"; do
    case "$a" in
        --apply) MODE="apply" ;;
        --check|"") ;;
        -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

# `키 = 값` 만 읽는다. 섹션은 쓰지 않는다 — 항목이 몇 개뿐이고, 규약의 다른
# settings.ini 들도 평평하다.
value_of() {
    [[ -r "$2" ]] || return 0
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$2" | tail -1 | sed 's/[[:space:]]*$//'
}

HOST="$(value_of host "$SETTINGS")"
COMPLEX_ID="$(value_of complex_id "$SETTINGS")"
SIP_DOMAIN="$(value_of sip_domain "$SETTINGS")"

if [[ "$MODE" == "apply" ]]; then
    [[ -n "$HOST" && -n "$COMPLEX_ID" ]] || { echo "host 와 complex_id 를 먼저 채우세요: ${SETTINGS}" >&2; exit 1; }

    # 반영이라고 할 수 있는 것은 릴레이 재시작뿐이다. 나머지 서비스는 자기
    # install.sh 가 설정 파일을 다시 쓸 때 이 값을 읽는다 — 그건 sudo 가 필요해
    # 여기서 하지 않는다. 무엇이 남았는지는 아래에 적는다.
    if command -v pm2 >/dev/null 2>&1; then
        pm2 restart websocket-relay --update-env >/dev/null 2>&1 \
            && echo "websocket-relay 를 다시 띄웠습니다." \
            || echo "websocket-relay 재시작에 실패했습니다 (pm2 list 로 확인하세요)."
    fi

    cp -f "$SETTINGS" "$APPLIED"
    echo "반영했습니다: ${APPLIED}"
    echo
    echo "아직 남은 것 (각 서비스가 sudo 로 자기 파일을 다시 씁니다):"
    echo "  cd services/janus    && sudo ./install.sh --apply"
    echo "  cd services/kamailio && sudo ./install.sh --apply"
    echo "  sudo ./nginx/install_nginx_stack.sh --skip-install"
    exit 0
fi

# ── 점검 ────────────────────────────────────────────────────────
info "사이트 값 (여러 서비스가 함께 쓰는 것)"

if [[ ! -f "$SETTINGS" ]]; then
    pend "아직 값이 없습니다: site/settings.ini — 마법사에서 채우세요"
    check_finish
    exit 1
fi

for pair in "host:$HOST" "complex_id:$COMPLEX_ID" "sip_domain:$SIP_DOMAIN"; do
    key="${pair%%:*}"; val="${pair#*:}"
    if [[ -n "$val" ]]; then ok "${key} = ${val}"; else pend "${key} 가 비어 있습니다"; fi
done

# 저장은 했는데 아직 반영하지 않은 상태를 가른다. 값이 바뀌었는데 릴레이가 옛
# 값으로 돌고 있으면 그 사실이 보여야 한다.
if [[ -n "$HOST" && -n "$COMPLEX_ID" ]]; then
    if [[ ! -f "$APPLIED" ]]; then
        pend "저장한 값을 아직 반영하지 않았습니다 → ./site/apply.sh --apply"
    elif ! diff -q "$SETTINGS" "$APPLIED" >/dev/null 2>&1; then
        pend "저장한 값이 반영본과 다릅니다 → ./site/apply.sh --apply"
    else
        ok "반영본과 같습니다"
    fi
fi

# 앱이 단지를 고를 때 받는 값이 디렉터리다. host 가 거기 것과 다르면 앱은
# 엉뚱한 주소로 붙는다 — 서버는 멀쩡히 돌고 로그도 조용하다.
if [[ -n "$COMPLEX_ID" && -r "$DIRECTORY" ]]; then
    expected="$(python3 - "$DIRECTORY" "$COMPLEX_ID" <<'PY' 2>/dev/null || true
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    sys.exit(0)
for region in d.get('regions', []):
    for c in region.get('complexes', []):
        if str(c.get('complexId', '')).lower() == sys.argv[2].lower():
            print(c.get('host', ''))
PY
)"
    if [[ -z "$expected" ]]; then
        warn "디렉터리에 단지 ${COMPLEX_ID} 가 없습니다 — 앱이 이 서버를 찾지 못합니다 (tools/directory.json)"
    elif [[ "$expected" != "$HOST" ]]; then
        warn "디렉터리의 host 와 다릅니다: ${HOST} ≠ ${expected} (tools/directory.json)"
    else
        ok "디렉터리와 일치합니다 (${expected})"
    fi
fi

check_finish
echo
echo "값을 고치려면 ${SETTINGS} 를 편집하거나 마법사에서 입력한 뒤 --apply 하세요."
