#!/usr/bin/env bash
#
# database.ini 가 선언한 것이 실제 MariaDB 에 반영됐는지 **확인만** 한다.
#
#   ./check-database.sh          사람이 보는 출력
#   ./check-database.sh --json   기계가 읽는 판정 (docs/check-contract.md)
#
# 왜 setup_mariadb.sh 에 붙이지 않았는가 — 그 스크립트는 root 로 도는 적용
# 스크립트다 (--dry-run 이 있지만 그것도 "무엇이 바뀔지" 를 보여 줄 뿐이다).
# 구축 마법사는 sudo 없이 돌므로, 확인만 하는 입구를 따로 둔다.
#
# 접속은 공용 계정(jyahn)으로 한다. 비밀번호는 secrets/ 파일에서 읽는다 —
# root 소켓 인증을 쓰면 sudo 가 필요해져 마법사에서 늘 "확인 불가" 가 된다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INI_FILE="${SCRIPT_DIR}/database.ini"
TEMPLATE="${SCRIPT_DIR}/mariadb.cnf.template"
SECRETS_DIR="${SCRIPT_DIR}/secrets"
OUTPUT_CNF="/etc/mysql/mariadb.conf.d/99-project.cnf"

# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
source "${PROJECT_ROOT}/lib/check-report.sh"
# 설치본이 저장소와 같은지 보는 공용 비교.
source "${PROJECT_ROOT}/lib/config-diff.sh"

check_init "database.schema"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

for arg in "$@"; do
    case "$arg" in
        --check) ;;             # 이 스크립트는 확인만 한다. 받아만 준다
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $arg" >&2
           echo "Usage: $0 [--check] [--json]" >&2; exit 1 ;;
    esac
done

# ---------- ini 에서 선언 읽기 ----------
# 값이 아니라 **무엇이 선언돼 있는가**만 본다. 파서를 다시 만들지 않는 이유다.
ini_sections() { sed -n "s/^\[$1:\(.*\)\]$/\1/p" "$INI_FILE"; }

# [user:이름] 아래의 키 하나를 읽는다. 다음 섹션 머리를 만나면 멈춘다.
ini_user_value() {
    local user="$1" key="$2"
    sed -n "/^\[user:${user}\]/,/^\[/p" "$INI_FILE" \
        | sed -n "s/^${key}[[:space:]]*=[[:space:]]*//p" | head -1
}

password_file_for() {
    local user="$1" declared
    declared="$(ini_user_value "$user" password_file)"
    if [[ -n "$declared" ]]; then
        [[ "$declared" == /* ]] && echo "$declared" || echo "${SCRIPT_DIR}/${declared}"
    else
        echo "${SECRETS_DIR}/${user}.pw"
    fi
}

# 비밀번호가 ps 에 노출되지 않도록 -p 대신 MYSQL_PWD 로 넘긴다.
# (services/kamailio/install.sh 의 verify_db_login 과 같은 이유다)
db_query() {
    local user="$1" password="$2" sql="$3"
    MYSQL_PWD="$password" mariadb -h 127.0.0.1 -u "$user" -N -B -e "$sql" 2>/dev/null || true
}

db_login_ok() {
    local user="$1" password="$2"
    MYSQL_PWD="$password" mariadb -h 127.0.0.1 -u "$user" -N -B -e 'SELECT 1;' >/dev/null 2>&1
}

# ---------- 점검 ----------

info "MariaDB"

MARIADB_UP=false
if ! command -v mariadb >/dev/null 2>&1; then
    pend "MariaDB 클라이언트가 없습니다 — sudo database/install_mariadb.sh 로 설치하세요"
elif systemctl is-active --quiet mariadb; then
    MARIADB_UP=true
    ok "서비스 동작 중 ($(mariadb --version 2>/dev/null | sed -n 's/.*Distrib \([^,]*\).*/\1/p'))"
else
    # 설치는 돼 있는데 떠 있지 않다. 아직 안 한 것이 아니라 어긋난 것이다.
    warn "MariaDB 가 떠 있지 않습니다 (systemctl status mariadb)"
fi

# 설치본이 지금 database.ini 대로 만든 것과 같은가.
#
# 있는지만 보면 "ini 를 고치고 setup_mariadb.sh 를 안 돌린" 상태를 못 잡는다.
# 그때 MariaDB 는 옛 설정으로 돌고 있고 어디에도 오류로 보이지 않는다.
# setup_mariadb.sh 가 만드는 방식 그대로 여기서도 만들어 맞춰 본다.
render_expected_cnf() {
    local options
    options="$(sed -n '/^\[server\]/,/^\[/p' "$INI_FILE" \
        | grep -E '^[A-Za-z0-9_]+[[:space:]]*=' \
        | sed -E 's/^([A-Za-z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$/\1 = \2/')"
    [[ -n "$options" ]] || return 1

    awk -v opts="$options" -v ts="(비교에서 뺀다)" -v src="$INI_FILE" \
        '{gsub(/\{\{SERVER_OPTIONS\}\}/, opts); gsub(/\{\{GENERATED_AT\}\}/, ts); gsub(/\{\{SOURCE_INI\}\}/, src); print}' \
        "$TEMPLATE"
}

if [[ ! -f "$OUTPUT_CNF" ]]; then
    if [[ -d "$(dirname "$OUTPUT_CNF")" ]]; then
        pend "서버 설정이 아직 없습니다: ${OUTPUT_CNF} → sudo database/setup_mariadb.sh"
    else
        skip "설정 디렉토리를 읽을 수 없어 확인을 건너뜁니다: $(dirname "$OUTPUT_CNF")"
    fi
elif [[ ! -f "$TEMPLATE" ]]; then
    ok "서버 설정 반영됨: ${OUTPUT_CNF}"
    skip "템플릿이 없어 내용 비교를 건너뜁니다: ${TEMPLATE}"
else
    ok "서버 설정 반영됨: ${OUTPUT_CNF}"
    EXPECTED_CNF="$(mktemp)"
    trap 'rm -f "$EXPECTED_CNF"' EXIT
    if render_expected_cnf > "$EXPECTED_CNF"; then
        # '생성 시각' 은 매번 달라지므로 양쪽에서 뺀다 (setup_mariadb.sh 도 그렇게 비교한다).
        report_config_diff "99-project.cnf" "sudo database/setup_mariadb.sh" \
            -s "database.ini 로 만든 것과" \
            -x '^# 생성 시각' \
            "$OUTPUT_CNF" "$EXPECTED_CNF" || true
    else
        skip "database.ini 의 [server] 를 읽지 못해 내용 비교를 건너뜁니다"
    fi
fi

# ---------- 사용자 ----------

info ""
info "사용자 (database.ini 가 선언한 것)"

ADMIN_USER=""
ADMIN_PW=""

while read -r user; do
    [[ -z "$user" ]] && continue
    pw_file="$(password_file_for "$user")"

    if [[ ! -r "$pw_file" ]]; then
        if [[ -e "$pw_file" ]]; then
            skip "${user} — 비밀번호 파일을 읽을 수 없습니다 (권한): ${pw_file}"
        else
            pend "${user} — 비밀번호 파일 없음: ${pw_file} → sudo database/setup_mariadb.sh 가 만듭니다"
        fi
        continue
    fi

    password="$(head -1 "$pw_file" | tr -d '\r\n')"

    if ! $MARIADB_UP; then
        skip "${user} — 서버가 떠 있지 않아 로그인 확인을 건너뜁니다"
        continue
    fi

    if db_login_ok "$user" "$password"; then
        ok "${user} — 로그인 확인 (host $(ini_user_value "$user" host))"
        # 스키마 조회에 쓸 계정을 하나 잡아 둔다. 여러 DB 를 볼 수 있는 쪽이 낫다.
        if [[ -z "$ADMIN_USER" || "$(ini_user_value "$user" databases)" == *","* ]]; then
            ADMIN_USER="$user"; ADMIN_PW="$password"
        fi
    else
        # 파일만 새로 생기고 DB 에는 반영되지 않은 상태다 (--dry-run 만 돌린 경우).
        warn "${user} — 로그인 실패. 파일의 비밀번호가 MariaDB 에 반영되지 않았습니다"
        warn "  해결: cd database && sudo ./setup_mariadb.sh   (--dry-run 없이)"
    fi
done < <(ini_sections user)

# ---------- 데이터베이스와 스키마 ----------

info ""
info "데이터베이스와 스키마"

while read -r db; do
    [[ -z "$db" ]] && continue

    if [[ -z "$ADMIN_USER" ]]; then
        skip "${db} — 접속할 수 있는 계정이 없어 확인을 건너뜁니다"
        continue
    fi

    tables="$(db_query "$ADMIN_USER" "$ADMIN_PW" \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${db}';")"

    if [[ "${tables:-0}" -gt 0 ]]; then
        ok "${db} — 테이블 ${tables}개"
    else
        # DB 가 없는 것과 비어 있는 것을 여기서 가르지 않는다. 할 일은 같다.
        pend "${db} — 스키마가 아직 없습니다 → sudo database/setup_mariadb.sh"
    fi
done < <(ini_sections database)

check_finish

echo ""
echo "적용은 이 스크립트가 하지 않습니다: cd database && sudo ./setup_mariadb.sh"
