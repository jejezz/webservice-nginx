#!/usr/bin/env bash
#
# Kamailio 계정 인증 설정을 설치한다.
#
#   ./install.sh                 현재 상태만 점검한다 (아무것도 바꾸지 않음)
#   sudo ./install.sh --apply    설정을 설치하고 kamailio 를 재시작한다
#   sudo ./install.sh --apply -y 확인 없이 진행
#   sudo ./install.sh --remove   설치한 설정을 걷어내고 기본 상태로 되돌린다
#
# 데이터베이스와 계정은 이 스크립트가 만들지 않는다. database/database.ini 가 소유하며
# sudo database/setup_mariadb.sh 로 적용한다. 이 스크립트는 그 결과를 확인만 한다.
#
# 배포판 설정 파일(/etc/kamailio/kamailio.cfg)은 건드리지 않는다.
# 그 파일이 이미 import_file 로 읽어 들이는 kamailio-local.cfg 만 설치한다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SECRET_FILE="${PROJECT_ROOT}/database/secrets/kamailio.pw"
TEMPLATE="${SCRIPT_DIR}/kamailio-local.cfg"
# 배포판 설정의 포크. 라우트 안에 코드를 넣어야 해서 소유한다 (docs/incoming-call.md).
MAIN_TEMPLATE="${SCRIPT_DIR}/kamailio.cfg"

KAM_ETC="/etc/kamailio"
LOCAL_CFG="${KAM_ETC}/kamailio-local.cfg"
MAIN_CFG="${KAM_ETC}/kamailio.cfg"
KAMCTLRC="${KAM_ETC}/kamctlrc"

DB_NAME="kamailio"
DB_USER="kamailio"
DB_HOST="localhost"

# ═══ 배포 설정 ═══════════════════════════════════════════════════════
#
# 장비마다 다른 값은 settings.ini 에 있습니다. 구축 마법사(/manager/setup)의
# 폼과 사람의 편집기가 그 파일을 쓰고, 이 스크립트가 읽습니다. 항목의 뜻은
# settings-schema.json 에, 규약은 docs/settings-contract.md 에 있습니다.
#
#   sip_domain        SIP 도메인
#   sip_listen_addr   SIP 를 받을 이 장비의 주소 — **장비마다 다릅니다**
#   sip_push_url      착신 푸시를 요청할 곳 (websocket-relay)
#
# 값이 형식에 맞지 않으면 --apply 가 아무것도 바꾸지 않고 멈춥니다.
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"
# 마지막으로 설치한 값. 화면이 '적용 대기' 를 이걸로 가른다.
APPLIED_FILE="${SCRIPT_DIR}/.applied-settings"

# settings.ini 에서 `키 = 값` 하나를 읽는다. 없으면 기본값.
# 절(section)은 쓰지 않는다 — node 쪽(lib/settings.js)도 같은 파일을 파싱한다.
# 사이트 값(여러 서비스가 함께 쓰는 것)을 읽는 도구. 서비스 값이 비었을 때만 쓴다.
source "${SCRIPT_DIR}/../../lib/site.sh"

settings_get() {
    local key="$1" fallback="${2:-}" v=""
    if [[ -r "$SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\\(.*\\)$/\\1/p" "$SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
    fi
    v="${v//[[:space:]]/}"
    echo "${v:-$fallback}"
}
# ═════════════════════════════════════════════════════════════════════

# SIP 도메인 — 이 값이 **세 곳**으로 흘러간다.
#   kamctlrc 의 SIP_DOMAIN      → kamctl add 가 subscriber.domain 에 넣는 값
#   kamailio-local.cfg 의 alias → Kamailio 가 이 도메인을 "내 것" 으로 인식
#   websocket-relay             → 승인할 때 만드는 SIP 계정의 도메인
#
# 셋이 어긋나면 계정은 만들어지는데 등록이 안 된다. 그래서 **사이트 값**을
# 기본으로 쓴다 (site/README.md). 이 서비스의 settings.ini 에 적으면 그것이
# 이긴다 — 한 장비만 다르게 두어야 할 때를 막지 않는다.
SIP_DOMAIN="$(settings_get sip_domain "$(site_get sip_domain 'pluto.org')")"

# SIP 를 받을 주소. listen= 을 하나라도 명시하면 Kamailio 는 **자동 바인딩을
# 멈추므로**, WS 용 5080 만 적으면 5060 이 통째로 닫힌다. 실제로 그렇게 만들었다가
# 인터폰이 쓰는 SIP 가 사라졌다. 그래서 여기서 함께 명시한다.
#
# 자동 바인딩은 docker0·virbr0 까지 잡았는데 SIP 에는 필요 없다. LAN 과 루프백만 연다.
#
# **기본값을 두지 않는다.** 이 장비의 주소를 다른 장비가 물려받을 수는 없다.
# 없으면 점검이 "아직 정하지 않았다" 로 보고하고, --apply 는 멈춘다.
SIP_LISTEN_ADDR="$(settings_get sip_listen_addr '')"

# 착신 푸시를 요청할 곳. websocket-relay 가 FCM 자격 증명과 토큰 테이블을 갖고
# 있으므로 그쪽에 맡긴다. 루프백 전용이라 같은 호스트에서만 부를 수 있다.
SIP_PUSH_URL="$(settings_get sip_push_url 'http://127.0.0.1:28099/sip-push')"

# shellcheck source=../../database/lib_mariadb.sh
source "${PROJECT_ROOT}/database/lib_mariadb.sh"

# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
source "${SCRIPT_DIR}/../../lib/check-report.sh"
# 설치본이 저장소와 같은지 보는 공용 비교.
source "${SCRIPT_DIR}/../../lib/config-diff.sh"

# --json 은 아래 인자 파싱보다 **먼저** 걸러낸다.
check_init "kamailio.config"    # docs/check-contract.md 의 step id
check_args "$@"
set -- "${CHECK_REST[@]:-}"

MODE="check"
ASSUME_YES=false

for arg in "$@"; do
    case "$arg" in
        --apply)    MODE="apply" ;;
        --remove)   MODE="remove" ;;
        --check)    MODE="check" ;;
        --yes|-y)   ASSUME_YES=true ;;
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $arg"; echo "Usage: $0 [--apply|--remove|--check] [--yes] [--json]"; exit 1 ;;
    esac
done

die()  { echo "오류: $*" >&2; exit 1; }

confirm() {
    $ASSUME_YES && return 0
    read -r -p "$1 [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

require_root() {
    [[ "$(id -u)" -eq 0 ]] || die "이 동작은 root 권한이 필요합니다. sudo 로 다시 실행하세요."
}

# Kamailio 가 쓸 자격 증명으로 실제 로그인해 본다.
#
# 'kamailio -c' 는 문법과 모듈만 검사한다. DB 접속은 fork 이후 child_init 에서 일어나므로
# 자격 증명이 틀려도 -c 는 통과하고, 재시작한 뒤에야 죽는다. 그래서 미리 직접 확인한다.
#
# 비밀번호가 ps 에 노출되지 않도록 -p 대신 MYSQL_PWD 로 넘긴다.
verify_db_login() {
    local password="$1"
    MYSQL_PWD="$password" mariadb -h "$DB_HOST" -u "$DB_USER" -D "$DB_NAME" \
        -N -B -e 'SELECT 1;' >/dev/null 2>&1
}

# 실제로 구동 중인 바이너리. systemd 유닛의 ExecStart 를 그대로 믿는다.
# (PATH 의 kamailio 는 소스빌드판일 수 있어 쓰지 않는다)
#
# 파이프로 head 를 물리지 않는다. set -o pipefail 아래에서 head 가 먼저 끝나면
# 앞 명령이 SIGPIPE 로 죽어 파이프라인 전체가 실패로 판정된다. 실제로 그 함정에
# 걸려 "alias 를 찾지 못했습니다" 라는 거짓 경고가 나온 적이 있다.
running_binary() {
    local raw first
    raw="$(systemctl show kamailio -p ExecStart --value 2>/dev/null || true)"
    raw="$(sed -n 's/.*path=\([^ ;]*\).*/\1/p' <<<"$raw")"
    first="${raw%%$'\n'*}"
    printf '%s' "$first"
}

# settings.ini 의 값이 쓸 만한지 본다.
#
# 화면(lib/settings.js)이 이미 한 번 걸렀지만, 파일은 손으로도 고칠 수 있으므로
# **root 로 도는 이쪽에서 다시 본다.** 둘 다 통과해야 설치된다.
#
# 결과를 바로 찍지 않고 배열에 담는 이유: 점검 모드에서는 규약대로 pend/warn 으로
# 내야 하고, --apply 에서는 die 로 멈춰야 하기 때문이다.
SETTINGS_PROBLEMS=()
SETTINGS_PENDING=()
validate_settings() {
    SETTINGS_PROBLEMS=()
    SETTINGS_PENDING=()

    [[ -r "$SETTINGS_FILE" ]] \
        || SETTINGS_PENDING+=("settings.ini 가 없습니다: ${SETTINGS_FILE} — 마법사의 설정 폼이나 편집기로 만드세요")

    [[ "$SIP_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
        || SETTINGS_PROBLEMS+=("sip_domain 이 도메인으로 보이지 않습니다: ${SIP_DOMAIN}")

    if [[ -z "$SIP_LISTEN_ADDR" ]]; then
        SETTINGS_PENDING+=("sip_listen_addr 를 아직 정하지 않았습니다 — 이 장비의 LAN 주소가 필요합니다")
    elif [[ ! "$SIP_LISTEN_ADDR" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
        SETTINGS_PROBLEMS+=("sip_listen_addr 가 IPv4 로 보이지 않습니다: ${SIP_LISTEN_ADDR}")
    elif ! ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qxF "$SIP_LISTEN_ADDR"; then
        # 이 장비에 없는 주소를 listen 에 적으면 kamailio 는 바인딩에 실패해 죽는다.
        # 문법 검사(-c)는 통과하므로 여기서 잡지 않으면 재시작에서야 드러난다.
        SETTINGS_PROBLEMS+=("sip_listen_addr ${SIP_LISTEN_ADDR} 는 이 장비의 주소가 아닙니다 — kamailio 가 바인딩에 실패합니다")
    fi

    [[ "$SIP_PUSH_URL" =~ ^https?://.+ ]] \
        || SETTINGS_PROBLEMS+=("sip_push_url 이 http(s) 주소가 아닙니다: ${SIP_PUSH_URL}")

    [[ ${#SETTINGS_PROBLEMS[@]} -eq 0 && ${#SETTINGS_PENDING[@]} -eq 0 ]]
}

# 저장한 값과 마지막으로 설치한 값이 다른가 = 사람이 --apply 를 해야 하는가.
#
# 적용 기록이 아예 없으면 비교할 대상이 없다. 그때는 "다르다" 가 아니라 "모른다"
# 이므로 대기로 보고하지 않는다 (lib/settings.js 와 같은 규칙이다).
report_settings_pending() {
    [[ -r "$APPLIED_FILE" ]] || {
        info "  (적용 기록이 아직 없습니다 — --apply 를 한 번 돌리면 이후로는 어긋남을 알 수 있습니다)"
        return 0
    }

    local key saved applied
    for key in sip_domain sip_listen_addr sip_push_url; do
        saved="$(settings_get "$key" '')"
        applied="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$APPLIED_FILE" | tail -1)"
        applied="${applied//[[:space:]]/}"
        [[ "$saved" == "$applied" ]] && continue
        pend "${key} 가 아직 반영되지 않았습니다: 설치본 '${applied}' → 저장한 값 '${saved}' (sudo $0 --apply)"
    done
}

# ---------- 점검 ----------

report() {
    local problems=0

    info "Kamailio"
    if systemctl is-active --quiet kamailio; then
        local bin; bin="$(running_binary)"
        ok "서비스 동작 중 — ${bin:-경로 확인 불가}"
        [[ -n "$bin" ]] && ok "버전: $("$bin" -v 2>/dev/null | sed -n '1s/version: //p')"
    else
        warn "서비스가 동작하지 않습니다 (systemctl status kamailio)"
        problems=$((problems + 1))
    fi

    if [[ -r "$MAIN_CFG" ]] && grep -q 'import_file "kamailio-local.cfg"' "$MAIN_CFG"; then
        ok "기본 설정이 kamailio-local.cfg 를 읽어 들입니다"
    else
        warn "기본 설정에 import_file \"kamailio-local.cfg\" 가 없습니다 — 이 방식을 쓸 수 없습니다"
        problems=$((problems + 1))
    fi

    info ""
    info "데이터베이스 (database/database.ini 가 소유)"
    if resolve_mariadb_credentials; then
        local tables subscribers
        tables="$(mdb_query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}';")"
        if [[ "${tables:-0}" -gt 0 ]]; then
            ok "${DB_NAME} 스키마 존재 (테이블 ${tables}개)"
            subscribers="$(mdb_query "SELECT COUNT(*) FROM ${DB_NAME}.subscriber;")"
            ok "등록된 SIP 계정: ${subscribers:-0}개"
        else
            pend "${DB_NAME} 스키마 없음 → sudo database/setup_mariadb.sh 를 먼저 실행하세요"
            problems=$((problems + 1))
        fi
    else
        # 확인을 못 한 것이지 잘못된 것이 아니다. problem 으로 두면 sudo 없이 도는
        # 마법사에서 이 단계가 영원히 막힌다 (docs/check-contract.md).
        skip "MariaDB 에 접속할 수 없어 확인을 건너뜁니다 (sudo 로 실행해 보세요)"
    fi

    if [[ -r "$SECRET_FILE" ]]; then
        ok "DB 비밀번호 파일: ${SECRET_FILE}"

        # 파일의 비밀번호가 실제로 MariaDB 에 반영됐는지 확인한다.
        # setup_mariadb.sh 를 --dry-run 으로만 돌리면 파일만 생기고 DB 는 그대로라 어긋난다.
        local password
        password="$(head -1 "$SECRET_FILE" | tr -d '\r\n')"
        if verify_db_login "$password"; then
            ok "DB 로그인 확인: ${DB_USER}@${DB_HOST} → ${DB_NAME}"
        else
            warn "DB 로그인 실패 — 파일의 비밀번호가 MariaDB 에 반영되지 않았습니다"
            warn "  해결: cd ${PROJECT_ROOT}/database && sudo ./setup_mariadb.sh   (--dry-run 없이)"
            problems=$((problems + 1))
        fi
    else
        pend "DB 비밀번호 파일 없음: ${SECRET_FILE} → setup_mariadb.sh 가 만들어 줍니다"
        problems=$((problems + 1))
    fi

    info ""
    info "인증 설정"
    if [[ -f "$LOCAL_CFG" ]]; then
        ok "설치됨: ${LOCAL_CFG}"
        # 0640 root:kamailio 이므로 일반 사용자는 읽을 수 없다.
        # 읽지 못한 것을 "꺼져 있다"로 보고하면 안 된다.
        if [[ -r "$LOCAL_CFG" ]]; then
            grep -q '^#!define WITH_AUTH' "$LOCAL_CFG" && ok "WITH_AUTH 활성" \
                || warn "WITH_AUTH 없음 — 인증 없이 REGISTER 를 받게 됩니다"
        else
            skip "내용 확인 불가 (root 권한 필요) — sudo $0 로 다시 실행하세요"
        fi
    else
        pend "설치되지 않음 — 지금은 인증 없이 REGISTER 를 받습니다"
    fi

    # 설치본이 저장소와 같은가 (docs/check-contract.md).
    #
    # 표식이나 특정 줄만 grep 하면 그 줄만 본다. 실제로 이 파일의 형제인
    # kamailio.cfg 에서 wt_timer 한 줄이 그렇게 빠져 있었고, 훅이 있는지만
    # 보던 점검은 통과로 나왔다. 파일 전체를 맞춰 보면 한 번에 드러난다.
    #
    # 자리표시자가 들어간 자리는 **키를 기준으로** 양쪽을 눌러 비교에서 뺀다.
    # 값이 맞는지는 여기서 보지 않는다 — 그것은 settings.ini 와
    # .applied-settings 를 비교하는 쪽의 일이다.
    info ""
    info "설치본이 저장소와 같은가"
    report_config_diff "kamailio.cfg" "sudo $0 --apply" "$MAIN_CFG" "$MAIN_TEMPLATE" \
        || problems=$((problems + 1))
    report_config_diff "kamailio-local.cfg" "sudo $0 --apply" \
        -n 's%^#!define DBURL .*%#!define DBURL «%' \
        -n 's%^alias=.*%alias=«%' \
        -n 's%^listen=\(udp\|tcp\):.*%listen=\1:«%' \
        -n 's%^#!define SIP_PUSH_URL .*%#!define SIP_PUSH_URL «%' \
        "$LOCAL_CFG" "$TEMPLATE" \
        || problems=$((problems + 1))

    info ""
    info "배포 설정 (settings.ini)"
    validate_settings || true

    if [[ ${#SETTINGS_PROBLEMS[@]} -eq 0 && ${#SETTINGS_PENDING[@]} -eq 0 ]]; then
        if [[ -n "$(settings_get sip_domain '')" ]]; then
            ok "SIP 도메인: ${SIP_DOMAIN} (이 서비스의 settings.ini)"
        else
            ok "SIP 도메인: ${SIP_DOMAIN} (site/settings.ini)"
        fi
        ok "SIP 수신 주소: ${SIP_LISTEN_ADDR}:5060 (udp+tcp)"
        ok "착신 푸시 요청: ${SIP_PUSH_URL}"
        report_settings_pending
    else
        # 빈 배열도 그대로 편다 (bash 5, set -u 에서 안전하다). 따옴표를 빼면
        # 문구가 공백에서 잘려 여러 줄로 흩어진다.
        local line
        for line in "${SETTINGS_PENDING[@]}"; do pend "$line"; done
        for line in "${SETTINGS_PROBLEMS[@]}"; do warn "$line"; done
        problems=$((problems + ${#SETTINGS_PROBLEMS[@]} + ${#SETTINGS_PENDING[@]}))
    fi

    info ""
    if [[ $problems -eq 0 ]]; then
        info "준비 완료. 설치하려면: sudo $0 --apply"
    else
        info "먼저 해결할 항목이 ${problems}개 있습니다. (위의 [--] / [!!])"
    fi
    return 0
}

# ---------- 설치 ----------

# 이번 실행에서 만든 백업으로 되돌린다.
#
# 메인 설정까지 소유하게 되면서 되돌릴 파일이 늘었다. rm 만으로는 부족하다 —
# kamailio.cfg 를 지우면 Kamailio 가 아예 뜨지 못한다.
BACKUPS=()
restore_backups() {
    local b f
    for b in "${BACKUPS[@]:-}"; do
        [[ -f "$b" ]] || continue
        f="${b%.bak.*}"
        cp -p "$b" "$f"
        info "  되돌림: ${f}"
    done
    # 백업이 없던 파일(처음 설치)은 지운다.
    [[ ${#BACKUPS[@]} -eq 0 ]] && rm -f "$LOCAL_CFG"
    return 0
}

backup() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    local dest="${file}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -p "$file" "$dest"
    BACKUPS+=("$dest")
    info "  백업: ${dest}"
}

# 배포판 설정의 포크를 설치한다.
#
# 원본은 dpkg 가 소유하므로 처음 한 번은 .dpkg-orig 로 남겨 둔다. 나중에 패키지가
# 업그레이드될 때 새 원본과 우리 변경점을 비교하는 기준이 된다.
write_main_cfg() {
    [[ -f "$MAIN_TEMPLATE" ]] || die "포크된 설정이 없습니다: ${MAIN_TEMPLATE}"

    if [[ ! -f "${MAIN_CFG}.dpkg-orig" && -f "$MAIN_CFG" ]] \
       && ! grep -q 'KAMAILIO-FORK' "$MAIN_CFG"; then
        cp -p "$MAIN_CFG" "${MAIN_CFG}.dpkg-orig"
        info "  원본 보관: ${MAIN_CFG}.dpkg-orig (업그레이드 때 비교 기준)"
    fi

    backup "$MAIN_CFG"
    install -o root -g root -m 644 "$MAIN_TEMPLATE" "$MAIN_CFG"
    info "  설치: ${MAIN_CFG} (배포판 설정의 포크)"
}

write_kamctlrc() {
    local password="$1"

    backup "$KAMCTLRC"
    cat > "$KAMCTLRC" <<EOF
## kamctl / kamdbctl 용 설정.
## services/kamailio/install.sh 가 생성했습니다. 직접 고치지 마세요.
##
## 데이터베이스와 사용자는 database/database.ini 가 소유합니다.
## 따라서 kamdbctl create / drop 은 쓰지 않습니다 — 스키마는 setup_mariadb.sh 가 적용합니다.

SIP_DOMAIN=${SIP_DOMAIN}

DBENGINE=MYSQL
DBHOST=${DB_HOST}
DBPORT=3306
DBNAME=${DB_NAME}

DBRWUSER="${DB_USER}"
DBRWPW="${password}"

## 평문 비밀번호를 subscriber.password 에 저장한다. 0 으로 두면 안 된다.
##
## 이 서버의 kamailio.cfg 는 auth_db 를 calculate_ha1=yes / password_column=password 로
## 설정한다. 즉 인증에 쓰이는 값은 평문 password 컬럼이고, ha1 컬럼은 읽지 않는다.
## 0 으로 두면 kamctl add 가 해시만 남겨 그 계정은 어떤 비밀번호로도 로그인할 수 없다.
STORE_PLAINTEXT_PW=1
EOF

    chown root:kamailio "$KAMCTLRC" 2>/dev/null || chown root:root "$KAMCTLRC"
    chmod 640 "$KAMCTLRC"
    info "  설치: ${KAMCTLRC} (0640)"
}

write_local_cfg() {
    local password="$1"
    local dburl="mysql://${DB_USER}:${password}@${DB_HOST}/${DB_NAME}"

    backup "$LOCAL_CFG"
    sed -e "s|__DBURL__|${dburl}|" \
        -e "s|__SIP_DOMAIN__|${SIP_DOMAIN}|" \
        -e "s|__SIP_LISTEN_ADDR__|${SIP_LISTEN_ADDR}|" \
        -e "s|__SIP_PUSH_URL__|${SIP_PUSH_URL}|" \
        "$TEMPLATE" > "$LOCAL_CFG"

    # 치환이 남김없이 됐는지 확인한다.
    #
    # 미치환이 남으면 Kamailio 는 그것을 그대로 값으로 받아들인다. 예를 들어
    # alias=__SIP_DOMAIN__ 이 되면 문법 오류가 아니라 "__SIP_DOMAIN__ 이라는
    # 도메인" 이 등록되어, kamailio -c 도 통과하고 기동도 되는데 정작 등록만
    # 안 되는 상태가 된다. 조용히 틀리는 종류라 여기서 잡는다.
    if grep -nE '__[A-Z_]+__' "$LOCAL_CFG" >/dev/null; then
        echo
        grep -nE '__[A-Z_]+__' "$LOCAL_CFG" | sed 's/^/    /'
        rm -f "$LOCAL_CFG"
        die "치환되지 않은 자리가 남았습니다 (위 목록). 설치를 취소했습니다."
    fi

    chown root:kamailio "$LOCAL_CFG" 2>/dev/null || chown root:root "$LOCAL_CFG"
    chmod 640 "$LOCAL_CFG"
    info "  설치: ${LOCAL_CFG} (0640)"
}

# 데이터베이스는 database/database.ini 가 소유하므로 여기서 만들지 않는다.
# setup_mariadb.sh 는 manager·ws_bridge 까지 함께 적용하는 스크립트라, Kamailio 설정을
# 설치하는 이 스크립트가 대신 호출하면 책임 범위를 넘는다. 준비됐는지 확인만 한다.
require_database() {
    database_ready && { ok "데이터베이스 확인: ${DB_NAME}, ${DB_USER}@${DB_HOST}"; return 0; }

    die "데이터베이스가 준비되지 않았습니다.

  cd ${PROJECT_ROOT}/database && sudo ./setup_mariadb.sh

--dry-run 없이 실행하세요. dry-run 은 ${SECRET_FILE##*/} 파일만 만들고
ALTER USER 는 실행하지 않아 파일과 DB 의 비밀번호가 어긋납니다."
}

# 스키마가 있고, secrets 의 비밀번호로 실제 로그인이 되는가.
database_ready() {
    resolve_mariadb_credentials || return 1

    local tables
    tables="$(mdb_query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}';")"
    [[ "${tables:-0}" -gt 0 ]] || return 1

    [[ -r "$SECRET_FILE" ]] || return 1
    local password
    password="$(head -1 "$SECRET_FILE" | tr -d '\r\n')"
    [[ -n "$password" ]] || return 1

    verify_db_login "$password"
}

apply() {
    require_root

    # 값 검증을 **가장 먼저** 한다. 되돌릴 것이 생기기 전에 멈추기 위해서다.
    if ! validate_settings; then
        local line
        for line in "${SETTINGS_PENDING[@]}"; do echo "  [--]   $line" >&2; done
        for line in "${SETTINGS_PROBLEMS[@]}"; do echo "  [!!]   $line" >&2; done
        die "settings.ini 의 값으로는 설치할 수 없습니다 (위 목록). 아무것도 바꾸지 않았습니다."
    fi

    [[ -f "$TEMPLATE" ]] || die "템플릿이 없습니다: ${TEMPLATE}"

    grep -q 'import_file "kamailio-local.cfg"' "$MAIN_CFG" \
        || die "기본 설정이 kamailio-local.cfg 를 읽지 않습니다: ${MAIN_CFG}"

    # 스키마와 계정은 setup_mariadb.sh 가 만든다. 여기서는 준비 여부만 확인한다.
    require_database

    local password
    password="$(head -1 "$SECRET_FILE" | tr -d '\r\n')"
    [[ -n "$password" ]] || die "비밀번호 파일이 비어 있습니다: ${SECRET_FILE}"
    ok "DB 로그인 확인: ${DB_USER}@${DB_HOST} → ${DB_NAME}"

    echo
    echo "다음을 설치합니다:"
    echo "  ${MAIN_CFG}         (배포판 설정의 포크 — 착신 푸시 훅 2곳)"
    echo "  ${LOCAL_CFG}   (WITH_MYSQL / WITH_AUTH / DBURL / alias=${SIP_DOMAIN})"
    echo "                                 listen: ${SIP_LISTEN_ADDR}:5060 (udp+tcp), 127.0.0.1:5060"
    echo "  ${KAMCTLRC}    (kamctl 용 접속 정보, SIP_DOMAIN=${SIP_DOMAIN})"
    echo
    echo "적용하면 이후 REGISTER 는 인증을 요구합니다."
    echo "subscriber 테이블에 계정이 없으면 아무도 등록할 수 없습니다. (현재 $(mdb_query "SELECT COUNT(*) FROM ${DB_NAME}.subscriber;")개)"
    echo
    confirm "진행할까요?" || { echo "취소했습니다."; exit 0; }

    write_main_cfg
    write_local_cfg "$password"
    write_kamctlrc "$password"

    # 문법 검사를 통과하지 못하면 되돌린다. 깨진 설정으로 재시작하면 서비스가 죽는다.
    local bin; bin="$(running_binary)"; bin="${bin:-/usr/sbin/kamailio}"
    # ⚠️ 반드시 설정 파일이 있는 디렉토리에서 실행한다.
    #
    # Kamailio 의 import_file 은 **CWD 기준**으로 상대 경로를 푼다. 저장소
    # 디렉토리에서 실행하면 거기 있는 kamailio-local.cfg(치환 전 템플릿)를 읽어,
    # 설치된 파일이 아니라 템플릿을 검사하게 된다. 그러면 이 롤백 장치가
    # 아무것도 지켜 주지 못한다. 실제로 그 상태였다.
    info "  설정 검사: ${bin} -c  (cwd=${KAM_ETC})"
    # 실패 내용을 **되돌리기 전에** 담는다.
    #
    # 이전에는 실패하면 먼저 롤백하고 나서 진단용으로 -c 를 다시 돌렸는데, 그때는
    # 이미 옛 설정으로 되돌아간 뒤라 "config file ok" 가 찍혔다. "검사 실패" 와
    # "config file ok" 가 나란히 나와, 진짜 원인(모듈 없음)은 보이지도 않았다.
    local check_log
    check_log="$( cd "$KAM_ETC" && "$bin" -c -f "$MAIN_CFG" 2>&1 )" || {
        echo
        printf '%s\n' "$check_log" | grep -E "ERROR|CRITICAL" | tail -10 | sed 's/^/    /'
        echo
        restore_backups
        die "설정 검사에 실패했습니다 (위 로그). 설치를 되돌렸고 kamailio 는 그대로 동작 중입니다."
    }
    ok "설정 검사 통과"

    # 이전 시도가 남긴 실패 카운터를 지운다. 안 그러면 설정이 옳아도
    # "Start request repeated too quickly" 로 막힐 수 있다.
    systemctl reset-failed kamailio 2>/dev/null || true
    systemctl restart kamailio || true

    # 자식 프로세스는 fork 이후에 DB 에 붙으므로 즉시 판정하면 실패를 놓친다.
    sleep 5

    if systemctl is-active --quiet kamailio; then
        ok "kamailio 재시작 완료"

        # 무엇을 실제로 설치했는지 남긴다. 화면은 settings.ini 와 이것을 비교해
        # '저장은 됐지만 아직 반영 안 됨' 을 알린다. 설치된 kamailio-local.cfg 는
        # 0640 root:kamailio 라 화면이 읽을 수 없어, 대신 이 파일을 남기는 것이다.
        #
        # **되돌린 경우에는 남기지 않는다** — 그때 설치된 것은 옛 값이다.
        {
            echo "; install.sh --apply 가 마지막으로 설치한 값. 손으로 고치지 마세요."
            echo "sip_domain = ${SIP_DOMAIN}"
            echo "sip_listen_addr = ${SIP_LISTEN_ADDR}"
            echo "sip_push_url = ${SIP_PUSH_URL}"
        } > "$APPLIED_FILE"
        chmod 644 "$APPLIED_FILE"
        info "  적용 기록: ${APPLIED_FILE}"
    else
        warn "기동에 실패했습니다. 설치한 설정을 되돌립니다."
        restore_backups

        # ⚠️ reset-failed 를 먼저 한다.
        #
        # 기동 실패가 반복되면 systemd 가 재시작 횟수 제한에 걸어
        # "Start request repeated too quickly" 로 더 이상 시도하지 않는다.
        # 그 상태에서는 설정을 올바르게 되돌려도 start 가 먹지 않는다.
        # 실제로 그 때문에 복구가 실패해 SIP 가 내려간 적이 있다.
        systemctl reset-failed kamailio 2>/dev/null || true
        systemctl start kamailio || true
        sleep 3

        if systemctl is-active --quiet kamailio; then
            info "  이전 상태로 복구했습니다. SIP 서비스는 살아 있습니다."
        else
            warn "  복구도 실패했습니다. 다음을 직접 실행해 보세요:"
            warn "    sudo systemctl reset-failed kamailio && sudo systemctl start kamailio"
            warn "    journalctl -u kamailio -n 40"
        fi
        echo
        journalctl -u kamailio -n 15 --no-pager 2>/dev/null | tail -15
        die "설정을 되돌렸습니다. 위 로그에서 원인을 확인하세요."
    fi

    # 기동한 Kamailio 가 이 도메인을 정말 "내 것" 으로 아는지 확인한다.
    # alias 가 빠지면 이 도메인으로 온 REGISTER 를 외부로 릴레이하려 하고,
    # 계정이 멀쩡해도 등록이 되지 않는다.
    # 출력을 먼저 담고 검사한다 — 파이프로 grep -q 를 물리면 grep 이 첫 일치에서
    # 파이프를 닫아 kamailio 가 SIGPIPE 로 죽고, pipefail 때문에 실패로 판정된다.
    local check_out
    check_out="$( cd "$KAM_ETC" && "$bin" -c -f "$MAIN_CFG" 2>&1 || true )"
    if grep -qF "${SIP_DOMAIN}" <<<"$check_out"; then
        ok "SIP 도메인 확인: ${SIP_DOMAIN} 이 alias 로 등록됨"
    else
        warn "alias 목록에서 ${SIP_DOMAIN} 을 찾지 못했습니다 — 이 도메인의 REGISTER 가 거부될 수 있습니다"
    fi

    echo
    echo "다음 단계 — 계정 등록:"
    echo "  sudo ${bin%/kamailio}/kamctl add 1001 '<비밀번호>'"
    echo "  자세한 내용은 accounts.md 참고"
}

remove() {
    require_root

    [[ -f "$LOCAL_CFG" ]] || { info "설치되어 있지 않습니다: ${LOCAL_CFG}"; exit 0; }

    echo "제거하면 인증이 꺼지고, 다시 누구나 REGISTER 할 수 있게 됩니다."
    confirm "계속할까요?" || { echo "취소했습니다."; exit 0; }

    backup "$LOCAL_CFG"
    rm -f "$LOCAL_CFG"
    info "  제거: ${LOCAL_CFG}"

    systemctl restart kamailio
    sleep 1
    systemctl is-active --quiet kamailio && ok "kamailio 재시작 완료" || die "재시작 실패 — journalctl -u kamailio -n 40"
}

case "$MODE" in
    check)  report; check_finish ;;
    apply)  apply ;;
    remove) remove ;;
esac
