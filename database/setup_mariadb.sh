#!/usr/bin/env bash
#
# database.ini 를 읽어 MariaDB 서버 설정과 데이터베이스/사용자를 적용한다.
#
#   sudo ./setup_mariadb.sh              적용 (설정이 바뀌면 재시작 여부를 확인)
#   sudo ./setup_mariadb.sh --dry-run    무엇이 바뀌는지만 출력
#   sudo ./setup_mariadb.sh --yes        확인 없이 진행 (재시작 포함)
#   sudo ./setup_mariadb.sh --no-restart 설정 파일만 쓰고 재시작하지 않음
#
# 이 스크립트는 추가와 갱신만 합니다. ini에 없는 데이터베이스나 사용자를 삭제하지 않습니다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INI_FILE="${SCRIPT_DIR}/database.ini"
TEMPLATE="${SCRIPT_DIR}/mariadb.cnf.template"
SECRETS_DIR="${SCRIPT_DIR}/secrets"
OUTPUT_CNF="/etc/mysql/mariadb.conf.d/99-project.cnf"
BACKUP_DIR="${SCRIPT_DIR}/backups"

# shellcheck source=lib_mariadb.sh
source "${SCRIPT_DIR}/lib_mariadb.sh"

DRY_RUN=false
ASSUME_YES=false
NO_RESTART=false

for arg in "$@"; do
    case "$arg" in
        --dry-run)    DRY_RUN=true ;;
        --yes|-y)     ASSUME_YES=true ;;
        --no-restart) NO_RESTART=true ;;
        *) echo "Unknown option: $arg"; echo "Usage: $0 [--dry-run] [--yes] [--no-restart]"; exit 1 ;;
    esac
done

# ---------- ini 파서 ----------
# setup_nginx.sh와 같은 방식. '#'와 ';'는 주석.
parse_ini() {
    local file="$1" section=""
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue

        if [[ "$line" =~ ^\[(.+)\]$ ]]; then
            section="${BASH_REMATCH[1]}"
            continue
        fi

        if [[ "$line" =~ ^([^=]+)=(.*)$ ]]; then
            local key val
            key="$(echo "${BASH_REMATCH[1]}" | sed 's/[[:space:]]*$//')"
            val="$(echo "${BASH_REMATCH[2]}" | sed 's/^[[:space:]]*//')"
            printf '%s|%s|%s\n' "$section" "$key" "$val"
        fi
    done < "$file"
}

get_value() {
    local section="$1" key="$2" default="${3:-}"
    local found
    found="$(grep -F "${section}|${key}|" <<< "$INI_DATA" | head -1 | cut -d'|' -f3-)"
    echo "${found:-$default}"
}

sections_with_prefix() {
    cut -d'|' -f1 <<< "$INI_DATA" | sort -u | grep "^${1}:" || true
}

# ---------- 유틸 ----------
info()  { echo "  $*"; }
step()  { echo ""; echo "== $* =="; }

confirm() {
    $ASSUME_YES && return 0
    local answer
    read -r -p "$1 [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

# SQL 식별자로 쓸 수 있는지 검사 (설정 파일을 통한 주입 방지)
validate_identifier() {
    local value="$1" what="$2"
    if [[ ! "$value" =~ ^[A-Za-z0-9_]+$ ]]; then
        echo "Error: 잘못된 ${what}: '${value}' (영문/숫자/밑줄만 허용)"
        exit 1
    fi
}

# GRANT의 host 부분. 와일드카드(192.168.0.%)와 넷마스크(192.168.0.0/255.255.255.0)를 모두 허용한다.
validate_host() {
    local value="$1"
    if [[ ! "$value" =~ ^[A-Za-z0-9_.%:/-]+$ ]]; then
        echo "Error: 잘못된 host: '${value}'"
        exit 1
    fi
}

sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }

# ini에 적힌 상대 경로를 database/ 기준 절대 경로로 바꾼다. ('../services/...' 형태 지원)
resolve_rel() {
    local p="$1"
    if [[ "$p" == /* ]]; then
        printf '%s' "$p"
    else
        (cd "$SCRIPT_DIR" && realpath -m "$p")
    fi
}

run_sql() {
    if $DRY_RUN; then
        echo "    [dry-run] $1"
        return 0
    fi
    mdb -e "$1"
}

query() { mdb_query "$1"; }

# ---------- 사전 확인 ----------
[[ -f "$INI_FILE" ]]  || { echo "Error: ${INI_FILE} 를 찾을 수 없습니다."; exit 1; }
[[ -f "$TEMPLATE" ]]  || { echo "Error: ${TEMPLATE} 를 찾을 수 없습니다."; exit 1; }

if ! command -v mariadb &>/dev/null; then
    echo "Error: MariaDB가 설치되어 있지 않습니다. ./install_mariadb.sh install 을 먼저 실행하세요."
    exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Error: root 권한이 필요합니다. sudo 로 실행하세요."
    exit 1
fi

if ! systemctl is-active --quiet mariadb; then
    echo "Error: MariaDB 서비스가 실행 중이 아닙니다."
    echo "  systemctl status mariadb"
    exit 1
fi

if ! resolve_mariadb_credentials; then
    echo "Error: MariaDB에 접속할 수 없습니다."
    echo ""
    mariadb_access_help
    exit 1
fi

echo "=== MariaDB 설정 적용 ==="
echo "설정 파일: ${INI_FILE}"
echo "접속 계정: ${MARIADB_CRED_LABEL}"
$DRY_RUN && echo "*** dry-run: 실제로 변경하지 않습니다 ***"

INI_DATA="$(parse_ini "$INI_FILE")"

# ---------- 1. 서버 설정 파일 생성 ----------
step "서버 설정"

SERVER_OPTIONS=""
while IFS='|' read -r section key value; do
    [[ "$section" == "server" ]] || continue
    # ini의 밑줄 표기를 그대로 쓴다. mysqld는 '_'와 '-'를 모두 인식한다.
    SERVER_OPTIONS+="${key} = ${value}"$'\n'
done <<< "$INI_DATA"

if [[ -z "$SERVER_OPTIONS" ]]; then
    echo "Error: [server] 섹션이 비어 있습니다."
    exit 1
fi

TMP_CNF="$(mktemp)"
trap 'rm -f "$TMP_CNF" "${TMP_CNF}.check"' EXIT

awk -v opts="$SERVER_OPTIONS" \
    -v ts="$(date '+%Y-%m-%d %H:%M:%S')" \
    -v src="$INI_FILE" \
    '{gsub(/\{\{SERVER_OPTIONS\}\}/, opts); gsub(/\{\{GENERATED_AT\}\}/, ts); gsub(/\{\{SOURCE_INI\}\}/, src); print}' \
    "$TEMPLATE" > "$TMP_CNF"

CNF_CHANGED=false
if [[ -f "$OUTPUT_CNF" ]]; then
    # 생성 시각 주석은 비교에서 제외한다.
    if diff -q <(grep -v '^# 생성 시각' "$OUTPUT_CNF") <(grep -v '^# 생성 시각' "$TMP_CNF") &>/dev/null; then
        info "변경 없음: ${OUTPUT_CNF}"
    else
        CNF_CHANGED=true
        info "변경 감지: ${OUTPUT_CNF}"
        echo ""
        diff -u <(grep -v '^# 생성 시각' "$OUTPUT_CNF") <(grep -v '^# 생성 시각' "$TMP_CNF") | sed -n '3,$p' | sed 's/^/    /' || true
        echo ""
    fi
else
    CNF_CHANGED=true
    info "신규 생성: ${OUTPUT_CNF}"
fi

if $CNF_CHANGED && ! $DRY_RUN; then
    # 잘못된 옵션 이름이 있으면 MariaDB가 아예 뜨지 않는다.
    # mariadbd가 인식하는 옵션 목록과 대조해 미리 걸러낸다.
    # (MariaDB 10.6에는 --validate-config 가 없어 이 방식을 쓴다)
    known="$(mktemp)"
    {
        mariadbd --verbose --help 2>/dev/null | grep -oE '^\s+--[a-z0-9-]+' | sed 's/[[:space:]]*--//'
        mariadbd --verbose --help 2>/dev/null \
            | sed -n '/^Variables (--variable-name=value)/,$p' | grep -oE '^[a-z0-9][a-z0-9-]+'
    } | tr '-' '_' | sort -u > "$known"

    unknown=()
    while IFS='|' read -r section key value; do
        [[ "$section" == "server" ]] || continue
        grep -qx "$(tr '-' '_' <<< "$key")" "$known" || unknown+=("$key")
    done <<< "$INI_DATA"
    rm -f "$known"

    if [[ ${#unknown[@]} -gt 0 ]]; then
        echo "Error: mariadbd가 모르는 옵션이 있습니다. 적용하지 않았습니다."
        printf '    %s\n' "${unknown[@]}"
        echo "  확인: mariadbd --verbose --help | less"
        exit 1
    fi

    PREVIOUS_CNF=""
    if [[ -f "$OUTPUT_CNF" ]]; then
        mkdir -p "$BACKUP_DIR"
        PREVIOUS_CNF="${BACKUP_DIR}/99-project.cnf.$(date +%Y%m%d-%H%M%S)"
        cp "$OUTPUT_CNF" "$PREVIOUS_CNF"
        info "이전 설정 백업: ${PREVIOUS_CNF}"
    fi

    install -m 644 -o root -g root "$TMP_CNF" "$OUTPUT_CNF"
    info "적용: ${OUTPUT_CNF}"
fi

# ---------- 2. 보안 항목 ----------
step "보안 설정"

if [[ "$(get_value security remove_anonymous_users false)" == "true" ]]; then
    count="$(query "SELECT COUNT(*) FROM mysql.global_priv WHERE user='';")"
    if [[ "${count:-0}" -gt 0 ]]; then
        run_sql "DELETE FROM mysql.global_priv WHERE user=''; FLUSH PRIVILEGES;"
        info "익명 사용자 ${count}개 제거"
    else
        info "익명 사용자 없음"
    fi
fi

if [[ "$(get_value security remove_test_database false)" == "true" ]]; then
    if [[ -n "$(query "SHOW DATABASES LIKE 'test';")" ]]; then
        run_sql "DROP DATABASE test;"
        info "test 데이터베이스 제거"
    else
        info "test 데이터베이스 없음"
    fi
fi

if [[ "$(get_value security disallow_remote_root false)" == "true" ]]; then
    remote_roots="$(query "SELECT host FROM mysql.global_priv WHERE user='root' AND host NOT IN ('localhost','127.0.0.1','::1');")"
    if [[ -n "$remote_roots" ]]; then
        while IFS= read -r host; do
            [[ -z "$host" ]] && continue
            run_sql "DROP USER 'root'@'$(sql_escape "$host")';"
            info "원격 root 제거: root@${host}"
        done <<< "$remote_roots"
        run_sql "FLUSH PRIVILEGES;"
    else
        info "원격 root 계정 없음"
    fi
fi

# ---------- 3. 데이터베이스 ----------
step "데이터베이스"

DEFAULT_CHARSET="$(get_value server character_set_server utf8mb4)"
DEFAULT_COLLATION="$(get_value server collation_server utf8mb4_unicode_ci)"

db_sections="$(sections_with_prefix database)"
if [[ -z "$db_sections" ]]; then
    info "정의된 데이터베이스 없음"
else
    while IFS= read -r section; do
        [[ -z "$section" ]] && continue
        db="${section#database:}"
        validate_identifier "$db" "데이터베이스 이름"

        charset="$(get_value "$section" charset "$DEFAULT_CHARSET")"
        collation="$(get_value "$section" collation "$DEFAULT_COLLATION")"
        validate_identifier "$charset" "charset"
        validate_identifier "$collation" "collation"

        if [[ -n "$(query "SHOW DATABASES LIKE '$(sql_escape "$db")';")" ]]; then
            info "이미 존재: ${db} (문자셋은 변경하지 않음)"
        else
            run_sql "CREATE DATABASE \`${db}\` CHARACTER SET ${charset} COLLATE ${collation};"
            info "생성: ${db} (${charset}/${collation})"
        fi

        # 스키마는 각 서비스 디렉토리가 소유한다. schema_dir 안의 *.sql 을 이름순으로 실행한다.
        # (001-initial.sql, 002-... 처럼 번호를 붙여 순서를 고정)
        # 모든 파일은 여러 번 실행해도 안전해야 한다. (CREATE TABLE IF NOT EXISTS 등)
        schema_dir="$(get_value "$section" schema_dir "")"
        schema_file="$(get_value "$section" schema_file "")"

        schema_files=()
        if [[ -n "$schema_dir" ]]; then
            schema_dir="$(resolve_rel "$schema_dir")"
            if [[ ! -d "$schema_dir" ]]; then
                echo "Error: 스키마 디렉토리가 없습니다: ${schema_dir}"
                exit 1
            fi
            while IFS= read -r f; do
                [[ -n "$f" ]] && schema_files+=("$f")
            done < <(find "$schema_dir" -maxdepth 1 -name '*.sql' -type f | sort)

            if [[ ${#schema_files[@]} -eq 0 ]]; then
                info "  스키마 파일 없음: ${schema_dir}"
            fi
        fi

        if [[ -n "$schema_file" ]]; then
            schema_file="$(resolve_rel "$schema_file")"
            if [[ ! -f "$schema_file" ]]; then
                echo "Error: 스키마 파일이 없습니다: ${schema_file}"
                exit 1
            fi
            schema_files+=("$schema_file")
        fi

        for f in ${schema_files[@]+"${schema_files[@]}"}; do
            if $DRY_RUN; then
                info "  [dry-run] 스키마 실행: ${f}"
            elif mdb --database="$db" < "$f"; then
                info "  스키마 적용: $(basename "$f")"
            else
                echo "Error: 스키마 실행 실패: ${f}"
                exit 1
            fi
        done

        if [[ ${#schema_files[@]} -gt 0 ]] && ! $DRY_RUN; then
            tables="$(query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$(sql_escape "$db")';")"
            info "  현재 테이블 ${tables}개"
        fi
    done <<< "$db_sections"
fi

# ---------- 4. 사용자와 권한 ----------
step "사용자"

resolve_password() {
    local user="$1" section="$2"
    local env_name file_path

    env_name="$(get_value "$section" password_env "")"
    if [[ -n "$env_name" ]]; then
        if [[ -z "${!env_name:-}" ]]; then
            echo "Error: 환경 변수 ${env_name} 가 비어 있습니다. (${section})" >&2
            exit 1
        fi
        printf '%s' "${!env_name}"
        return
    fi

    file_path="$(get_value "$section" password_file "")"
    if [[ -n "$file_path" ]]; then
        [[ "$file_path" == /* ]] || file_path="${SCRIPT_DIR}/${file_path#./}"
        if [[ ! -f "$file_path" ]]; then
            echo "Error: 비밀번호 파일이 없습니다: ${file_path}" >&2
            exit 1
        fi
        head -1 "$file_path" | tr -d '\n'
        return
    fi

    # 지정이 없으면 secrets/<user>.pw 를 쓰거나 새로 만든다.
    local generated="${SECRETS_DIR}/${user}.pw"
    if [[ -f "$generated" ]]; then
        head -1 "$generated" | tr -d '\n'
        return
    fi

    mkdir -p "$SECRETS_DIR"
    chmod 700 "$SECRETS_DIR"
    local pw
    pw="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
    printf '%s\n' "$pw" > "$generated"
    chmod 600 "$generated"
    # 스크립트를 sudo로 실행하므로 소유자를 원래 사용자로 돌려준다.
    if [[ -n "${SUDO_USER:-}" ]]; then
        chown -R "${SUDO_USER}:$(id -gn "$SUDO_USER")" "$SECRETS_DIR"
    fi
    echo "    새 비밀번호를 생성했습니다: ${generated}" >&2
    printf '%s' "$pw"
}

user_sections="$(sections_with_prefix user)"
if [[ -z "$user_sections" ]]; then
    info "정의된 사용자 없음"
else
    while IFS= read -r section; do
        [[ -z "$section" ]] && continue
        user="${section#user:}"
        validate_identifier "$user" "사용자 이름"

        host="$(get_value "$section" host localhost)"
        validate_host "$host"

        privileges="$(get_value "$section" privileges ALL)"
        if [[ ! "$privileges" =~ ^[A-Za-z_,\ ]+$ ]]; then
            echo "Error: 잘못된 privileges: '${privileges}'"
            exit 1
        fi

        password="$(resolve_password "$user" "$section")"
        esc_user="$(sql_escape "$user")"
        esc_host="$(sql_escape "$host")"
        esc_pw="$(sql_escape "$password")"

        exists="$(query "SELECT COUNT(*) FROM mysql.user WHERE user='${esc_user}' AND host='${esc_host}';")"
        if [[ "${exists:-0}" -gt 0 ]]; then
            run_sql "ALTER USER '${esc_user}'@'${esc_host}' IDENTIFIED BY '${esc_pw}';"
            info "갱신: ${user}@${host} (비밀번호 반영)"
        else
            run_sql "CREATE USER '${esc_user}'@'${esc_host}' IDENTIFIED BY '${esc_pw}';"
            info "생성: ${user}@${host}"
        fi

        databases="$(get_value "$section" databases "")"
        if [[ -z "$databases" ]]; then
            info "  권한 대상 databases 미지정 — 권한을 주지 않음"
            continue
        fi

        IFS=',' read -ra db_list <<< "$databases"
        for db in "${db_list[@]}"; do
            db="$(echo "$db" | xargs)"
            [[ -z "$db" ]] && continue

            if [[ "$db" == "*" ]]; then
                run_sql "GRANT ${privileges} ON *.* TO '${esc_user}'@'${esc_host}';"
                info "  권한: ${privileges} ON *.*"
            else
                validate_identifier "$db" "데이터베이스 이름"
                run_sql "GRANT ${privileges} ON \`${db}\`.* TO '${esc_user}'@'${esc_host}';"
                info "  권한: ${privileges} ON ${db}.*"
            fi
        done

        run_sql "FLUSH PRIVILEGES;"
    done <<< "$user_sections"
fi

# ---------- 5. 재시작 ----------
step "적용"

if $DRY_RUN; then
    echo "dry-run 이므로 아무것도 변경하지 않았습니다."
    exit 0
fi

if ! $CNF_CHANGED; then
    info "서버 설정 변경이 없어 재시작하지 않습니다."
elif $NO_RESTART; then
    info "--no-restart: 설정 파일만 적용했습니다. 반영하려면 'sudo systemctl restart mariadb'."
else
    echo "서버 설정이 바뀌었습니다. 반영하려면 MariaDB를 재시작해야 하며,"
    echo "재시작 동안 연결된 애플리케이션의 DB 접속이 끊깁니다."

    connected="$(query "SELECT COUNT(*) FROM information_schema.processlist WHERE user NOT IN ('root','system user');")"
    [[ "${connected:-0}" -gt 0 ]] && echo "현재 연결된 클라이언트: ${connected}개"

    if confirm "지금 재시작할까요?"; then
        if systemctl restart mariadb && sleep 2 && systemctl is-active --quiet mariadb; then
            info "재시작 완료 — 서비스 정상"
        else
            # 새 설정 때문에 서버가 죽었다. 이전 상태로 되돌리고 다시 살린다.
            echo ""
            echo "!! MariaDB가 시작되지 않았습니다. 설정을 되돌립니다. !!"

            if [[ -n "${PREVIOUS_CNF:-}" && -f "${PREVIOUS_CNF}" ]]; then
                install -m 644 -o root -g root "$PREVIOUS_CNF" "$OUTPUT_CNF"
                info "복원: ${PREVIOUS_CNF} -> ${OUTPUT_CNF}"
            else
                rm -f "$OUTPUT_CNF"
                info "새로 만든 ${OUTPUT_CNF} 를 삭제"
            fi

            if systemctl restart mariadb && sleep 2 && systemctl is-active --quiet mariadb; then
                echo "이전 설정으로 복구했습니다. database.ini 의 값을 확인하세요."
            else
                echo "복구에도 실패했습니다. 직접 확인이 필요합니다:"
                echo "  journalctl -u mariadb -n 50 --no-pager"
            fi
            exit 1
        fi
    else
        info "재시작하지 않았습니다. 나중에 'sudo systemctl restart mariadb' 를 실행하세요."
    fi
fi

echo ""
echo "=== 완료 ==="
[[ -d "$SECRETS_DIR" ]] && echo "생성된 비밀번호는 ${SECRETS_DIR}/ 에 있습니다. (권한 600)"
echo "상태 확인: ./install_mariadb.sh status"
