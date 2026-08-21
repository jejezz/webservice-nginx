#!/usr/bin/env bash
#
# SIP 계정이 실제로 쓸 수 있는 모양인지 **확인만** 한다. sudo 가 필요 없다.
#
#   ./check-accounts.sh          사람이 보는 출력
#   ./check-accounts.sh --json   기계가 읽는 판정 (docs/check-contract.md)
#
# 계정을 만드는 것은 여기서 하지 않습니다 — 비밀번호는 사람이 정합니다
# (accounts.md). 이 스크립트는 만들어진 것이 **등록될 수 있는 상태인지**만
# 봅니다. 조용히 실패하는 자리가 둘 있어서입니다.
#
#   ① 도메인이 어긋난 계정
#      auth_check 는 단말이 보낸 From 도메인($fd)으로 subscriber 를 찾습니다.
#      계정의 domain 이 alias(sip_domain)와 다르면 계정은 있는데 등록만
#      안 됩니다. 오류 문구도 "그런 계정 없음" 이 아니라 인증 실패입니다.
#
#   ② 비밀번호 컬럼이 빈 계정
#      이 서버의 auth_db 는 calculate_ha1=yes / password_column=password 라
#      평문 password 를 씁니다. kamctlrc 의 STORE_PLAINTEXT_PW 가 0 인 채로
#      만들면 ha1 만 남아, 그 계정은 **어떤 비밀번호로도** 로그인하지 못합니다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DB_NAME="kamailio"
DB_USER="kamailio"
DB_HOST="localhost"
DB_PW_FILE="${PROJECT_ROOT}/database/secrets/kamailio.pw"
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"

source "${PROJECT_ROOT}/lib/check-report.sh"

check_init "sip.accounts"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

for arg in "$@"; do
    case "$arg" in
        --check) ;;             # 이 스크립트는 확인만 한다
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $arg" >&2
           echo "Usage: $0 [--check] [--json]" >&2; exit 1 ;;
    esac
done

# 설정의 SIP 도메인. 없으면 kamailio/install.sh 의 기본값과 같게 둔다.
sip_domain() {
    local v=""
    [[ -r "$SETTINGS_FILE" ]] && v="$(sed -n 's/^[[:space:]]*sip_domain[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' "$SETTINGS_FILE" | tail -1)"
    v="${v//[[:space:]]/}"
    echo "${v:-pluto.org}"
}

# 비밀번호는 ps 에 노출되지 않게 MYSQL_PWD 로 넘긴다. 비밀번호 컬럼은
# **읽지 않는다** — 여기서 보는 것은 비어 있는지 여부뿐이다.
db_query() {
    MYSQL_PWD="$(head -1 "$DB_PW_FILE" | tr -d '\r\n')" \
        mariadb -h "$DB_HOST" -u "$DB_USER" -D "$DB_NAME" -N -B -e "$1" 2>/dev/null
}

DOMAIN="$(sip_domain)"

info "SIP 계정 (subscriber 테이블 · 도메인 ${DOMAIN})"

if [[ ! -r "$DB_PW_FILE" ]]; then
    skip "DB 비밀번호 파일을 읽을 수 없어 확인을 건너뜁니다: ${DB_PW_FILE}"
elif ! command -v mariadb >/dev/null 2>&1; then
    skip "mariadb 클라이언트가 없어 확인을 건너뜁니다"
else
    TOTAL="$(db_query "SELECT COUNT(*) FROM subscriber;" || true)"

    if [[ -z "$TOTAL" ]]; then
        skip "subscriber 테이블을 읽지 못해 확인을 건너뜁니다 (DB 접속 실패)"
    elif [[ "$TOTAL" -eq 0 ]]; then
        pend "계정이 하나도 없습니다 — 아무도 등록할 수 없습니다"
        info "         sudo /usr/sbin/kamctl add 1001 '<비밀번호>'   (accounts.md)"
    else
        ok "계정 ${TOTAL}개"

        # 어떤 계정이 있는지 보여 준다. 사람이 "쓸 것이 다 있는지" 를 판단할
        # 근거다 — 그 판단만은 기계가 대신하지 않는다.
        while read -r name dom; do
            [[ -z "$name" ]] && continue
            if [[ "$dom" == "$DOMAIN" ]]; then
                ok "  ${name}@${dom}"
            else
                warn "  ${name}@${dom} — 설정의 도메인(${DOMAIN})과 달라 등록되지 않습니다"
            fi
        done < <(db_query "SELECT username, domain FROM subscriber ORDER BY username;" || true)

        EMPTY="$(db_query "SELECT COUNT(*) FROM subscriber WHERE password IS NULL OR password = '';" || true)"
        if [[ "${EMPTY:-0}" -gt 0 ]]; then
            warn "비밀번호가 빈 계정 ${EMPTY}개 — 어떤 비밀번호로도 로그인하지 못합니다"
            warn "  kamctlrc 의 STORE_PLAINTEXT_PW 가 1 인지 보고, 그 계정을 다시 만드세요"
        fi
    fi
fi

check_finish

echo ""
echo "계정을 만드는 것은 사람의 몫입니다 — accounts.md 를 보세요."
