#!/usr/bin/env bash
#
# 시험용 세대의 SIP 계정을 만든다. **sudo 가 필요 없다.**
#
#   ./ensure-test-accounts.sh          없는 것만 만든다 (있으면 그대로 둔다)
#   ./ensure-test-accounts.sh --check  무엇이 있는지 보기만 한다
#
# ── 왜 필요한가 ──────────────────────────────────────────────────
# `verify-call.sh --run` 과 `verify-bridge.sh`, 그리고 Janus 대시보드의 '시험
# 통화' 는 계정 넷을 쓴다. 그런데 그 계정을 만드는 것은 아무 데도 없었다 —
# 스크립트가 "대시보드에서 만들고 비밀번호를 파일에 두세요" 라고 사람에게
# 넘겼다. 그래서 갓 설치한 장비에서는 **시험 통화 단계가 반드시 막힌다.**
#
# 계정 발급은 원래 사람의 몫이다 (services/kamailio/accounts.md). 하지만 이 넷은
# 다르다 — **실재하지 않는 세대(9999동 9999호)의 시험용**이라 누가 쓸지 정할
# 것이 없고, 비밀번호도 사람이 기억할 이유가 없다. 그래서 여기서 만든다.
#
# 실재하는 세대의 계정은 여전히 만들지 않는다. 모바일·월패드는 websocket-relay
# 가 승인·등록 때 만들고(docs/identity.md), 인터폰은 사람이 만든다.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SECRETS_DIR="${SCRIPT_DIR}/secrets"

source "${REPO_ROOT}/lib/site.sh"

# 시험용 세대 — 9999동 9999호. 실재하지 않는 주소라 진짜 세대와 부딪히지 않는다
# (docs/identity.md 의 '시험용 세대'). 뒤 두 자리는 순번이다.
HOME_NUMBER="99999999"
SEQS=(01 02 03 04)

DOMAIN="$(site_get sip_domain 'pluto.org')"
DB_PW_FILE="${REPO_ROOT}/database/secrets/jyahn.pw"
DB_USER="jyahn"

CHECK_ONLY=0
for a in "$@"; do
    case "$a" in
        --check) CHECK_ONLY=1 ;;
        -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

db() {
    [[ -r "$DB_PW_FILE" ]] || return 1
    MYSQL_PWD="$(head -1 "$DB_PW_FILE" | tr -d '\r\n')" \
        mariadb -h 127.0.0.1 -u "$DB_USER" -N -B -e "$1" 2>/dev/null
}

if ! db "SELECT 1" >/dev/null; then
    echo "DB 에 붙지 못했습니다 (${DB_PW_FILE})." >&2
    echo "  → sudo database/setup_mariadb.sh 를 먼저 돌리세요." >&2
    exit 1
fi

echo "시험용 계정 (${HOME_NUMBER}xx@${DOMAIN})"
made=0

umask 077
mkdir -p "$SECRETS_DIR"

for seq in "${SEQS[@]}"; do
    user="${HOME_NUMBER}${seq}"
    pw_file="${SECRETS_DIR}/sip-${user}.pw"

    in_db="$(db "SELECT COUNT(*) FROM kamailio.subscriber WHERE username='${user}' AND domain='${DOMAIN}';")"
    has_file=0; [[ -s "$pw_file" ]] && has_file=1

    if [[ "${in_db:-0}" -gt 0 && $has_file -eq 1 ]]; then
        # 둘 다 있어도 값이 어긋나 있을 수 있다. 그 경우가 실제로 있었다 —
        # DB 는 '1234', 파일은 다른 값이었고 등록이 904 로 실패했다.
        same="$(db "SELECT COUNT(*) FROM kamailio.subscriber
                     WHERE username='${user}' AND domain='${DOMAIN}'
                       AND password=$(printf "'%s'" "$(tr -d '\r\n' < "$pw_file" | sed "s/'/''/g")");")"
        if [[ "${same:-0}" -gt 0 ]]; then
            echo "  ✓ ${user}"
            continue
        fi
        echo "  ! ${user} — 파일과 DB 의 비밀번호가 다릅니다"
        [[ $CHECK_ONLY -eq 1 ]] && continue
    elif [[ "${in_db:-0}" -gt 0 || $has_file -eq 1 ]]; then
        echo "  ! ${user} — 한쪽만 있습니다 (DB ${in_db:-0} · 파일 ${has_file})"
        [[ $CHECK_ONLY -eq 1 ]] && continue
    else
        echo "  · ${user} 없음"
        [[ $CHECK_ONLY -eq 1 ]] && continue
    fi

    # 파일 쪽 값을 살릴 수 있으면 살린다 — 사람이 다른 곳에 적어 두었을 수 있다.
    if [[ $has_file -eq 1 ]]; then
        pw="$(tr -d '\r\n' < "$pw_file")"
    else
        pw="$(openssl rand -hex 12)"
        printf '%s' "$pw" > "$pw_file"
        chmod 600 "$pw_file"
    fi

    esc="$(printf '%s' "$pw" | sed "s/'/''/g")"
    db "INSERT INTO kamailio.subscriber (username, domain, password, ha1, ha1b)
        VALUES ('${user}', '${DOMAIN}', '${esc}',
                MD5('${user}:${DOMAIN}:${esc}'), MD5('${user}@${DOMAIN}:${DOMAIN}:${esc}'))
        ON DUPLICATE KEY UPDATE password=VALUES(password), ha1=VALUES(ha1), ha1b=VALUES(ha1b);" >/dev/null \
        && { echo "  + ${user} 만들었습니다"; made=$((made + 1)); } \
        || echo "  ✗ ${user} 만들지 못했습니다"
done

echo
if [[ $CHECK_ONLY -eq 1 ]]; then
    echo "--check 라 아무것도 바꾸지 않았습니다. 만들려면 옵션 없이 실행하세요."
elif [[ $made -gt 0 ]]; then
    echo "${made}개를 만들었습니다. 이제 ./verify-call.sh --run 이 돕니다."
else
    echo "이미 다 있습니다."
fi
