#!/usr/bin/env bash
#
# coturn(TURN/STUN) 설정을 설치한다.
#
#   ./install.sh                 현재 상태만 점검한다 (아무것도 바꾸지 않음)
#   sudo ./install.sh --apply    패키지를 넣고 설정을 설치한 뒤 기동한다
#   sudo ./install.sh --apply -y 확인 없이 진행
#   sudo ./install.sh --remove   설정을 걷어내고 기본 상태로 되돌린다 (패키지는 남긴다)
#
# coturn 은 Kamailio 와 같은 자리에 있다 — apt 로 패키지를 받고, 그 패키지가
# 자기 systemd 유닛(coturn.service)을 함께 설치한다. 우리는 유닛을 소유하지
# 않고 /etc/turnserver.conf 와 /etc/default/coturn 의 활성화 플래그만 소유한다.
#
# ⚠️ 이 서비스에는 bootstrap.sh 를 따로 두지 않는다. Kamailio 는 패키지 설치를
#    bootstrap.sh 에, 설정 적용을 install.sh 에 나누어 두지만, coturn 은
#    "패키지 하나 + 설정 파일 하나" 로 끝나는 단순한 구성이라 나누는 이득이
#    작다고 판단했다. 그래서 --apply 가 패키지 설치까지 함께 한다 — 다만
#    점검(기본 모드)에서는 apt 를 건드리지 않고 "있는지/없는지" 만 본다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TEMPLATE="${SCRIPT_DIR}/turnserver.conf"
ETC_CFG="/etc/turnserver.conf"
DEFAULT_FILE="/etc/default/coturn"
PKG="coturn"

SECRETS_DIR="${SCRIPT_DIR}/secrets"
STATIC_AUTH_SECRET_FILE="${SECRETS_DIR}/static-auth-secret"

# ═══ 배포 설정 ═══════════════════════════════════════════════════════
#
# 장비마다 다른 값은 settings.ini 에 있습니다. 대시보드의 '설정' 화면과 사람의
# 편집기가 그 파일을 쓰고, 이 스크립트가 읽습니다. 항목의 뜻은
# settings-schema.json 에, 규약은 docs/settings-contract.md 에 있습니다.
#
# static_auth_secret 은 여기 없습니다 — 사람이 입력하는 값이 아니라 기계가
# 생성하는 비밀이라 secrets/ 에 둡니다 (services/janus 의 admin-secret·
# api-secret 과 같은 자리 — 아래 ensure_secret 참고).
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"
APPLIED_FILE="${SCRIPT_DIR}/.applied-settings"

DEFAULT_REALM="turn.local"
DEFAULT_RELAY_RANGE="49160-49560"
DEFAULT_LISTENING_PORT="3478"

# settings.ini 에서 `키 = 값` 하나를 읽는다. 없으면 기본값.
# 절(section)은 쓰지 않는다 — node 쪽(lib/settings.js)도 같은 파일을 파싱한다.
settings_get() {
    local key="$1" fallback="${2:-}" v=""
    if [[ -r "$SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\\(.*\\)$/\\1/p" "$SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
    fi
    v="${v//[[:space:]]/}"
    echo "${v:-$fallback}"
}

# 사이트 값(여러 서비스가 함께 쓰는 것). 서비스 값이 비었을 때만 쓴다.
source "${PROJECT_ROOT}/lib/site.sh"

# Janus 의 public_ip 를 그대로 물려받는다.
#
# 이 장비는 Janus 와 같은 회선·같은 공유기를 쓴다(같은 호스트다). 그런데
# public_ip 를 site/settings-schema.json 으로 올리지는 않았다 — Janus 는 지금
# 사이트 값을 쓰지 않고 자기 settings.ini 를 직접 쓰는 유일한 값으로 두고
# 있고(services/janus/install.sh 에 site.sh 를 아예 불러오지 않는다), 여기서
# 사이트 층까지 새로 만드는 것은 이 작업의 범위를 넘어선다고 판단했다
# (docs/plan.md 의 "아직 안 한 일" 참고). 대신 **Janus 의 settings.ini/
# .applied-settings 를 직접 읽는다** — 최소한의 결합으로 같은 효과를 낸다.
#
# 우선순위: Janus 의 .applied-settings(실제로 설치된 값) → settings.ini(아직
# 반영 전이라도 사람이 정한 값) → 없음. coturn 자신의 settings.ini 에 값이
# 있으면 그것이 **항상 이긴다** — 이 장비만 다르게 두어야 할 때를 막지 않는다.
janus_public_ip() {
    local dir="${PROJECT_ROOT}/services/janus" f
    for f in "${dir}/.applied-settings" "${dir}/settings.ini"; do
        [[ -r "$f" ]] || continue
        local v
        v="$(sed -n 's/^[[:space:]]*public_ip[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' "$f" | tail -1)"
        v="${v%%[;#]*}"; v="${v//[[:space:]]/}"
        [[ -n "$v" ]] && { echo "$v"; return 0; }
    done
    echo ""
}

PUBLIC_IP="$(settings_get public_ip "$(janus_public_ip)")"
REALM="$(settings_get realm "$(site_get host "$DEFAULT_REALM")")"
RELAY_PORT_RANGE="$(settings_get relay_port_range "$DEFAULT_RELAY_RANGE")"
LISTENING_PORT="$(settings_get listening_port "$DEFAULT_LISTENING_PORT")"
# ═════════════════════════════════════════════════════════════════════

# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
source "${SCRIPT_DIR}/../../lib/check-report.sh"
# 설치본이 저장소와 같은지 보는 공용 비교.
source "${SCRIPT_DIR}/../../lib/config-diff.sh"

# --json 은 아래 인자 파싱보다 **먼저** 걸러낸다.
check_init "coturn.config"     # docs/check-contract.md 의 step id
check_args "$@"
set -- "${CHECK_REST[@]:-}"

MODE="check"
ASSUME_YES=false

for arg in "$@"; do
    case "$arg" in
        --apply)  MODE="apply" ;;
        --remove) MODE="remove" ;;
        --check)  MODE="check" ;;
        --yes|-y) ASSUME_YES=true ;;
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $arg"; echo "Usage: $0 [--check|--apply|--remove] [--yes] [--json]"; exit 1 ;;
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

# 패키지가 설치돼 있는가. dpkg 상태만 본다 — apt 를 건드리지 않는다.
# (services/kamailio/bootstrap.sh 의 pkg_installed 와 같은 관용구)
pkg_installed() { dpkg -l "$1" 2>/dev/null | grep -q "^ii"; }

# 이 장비에 없는 값을 다른 장비가 물려받지 않도록, jcfg 에서 직접 범위를 읽는다.
# services/janus/install.sh 의 jcfg_rtp_range 와 같은 관용구다.
jcfg_rtp_range() {
    local file="$1"
    [[ -r "$file" ]] || return 0
    sed -n 's/^[[:space:]]*rtp_port_range[[:space:]]*=[[:space:]]*"\([0-9]\{1,\}\)-\([0-9]\{1,\}\)".*/\1 \2/p' "$file" | head -1
}

# 두 구간이 겹치는가. [a1,a2] 와 [b1,b2] 는 a1<=b2 이고 b1<=a2 일 때 겹친다.
ranges_overlap() {
    [[ $1 -le $4 && $3 -le $2 ]]
}

# 다른 서비스가 실제로/기본으로 쓰는 미디어 포트 범위 셋. 겹치면 조용히
# 실패한다 — 통화는 붙는데 TURN 릴레이만 포트를 못 잡거나, 반대로 릴레이가
# Janus 나 rtpengine 의 포트를 가로챈다. 값은 각 서비스가 소유하므로 여기서는
# 읽기만 한다.
janus_webrtc_range() {
    local dir="${PROJECT_ROOT}/services/janus" configured
    configured="$(sed -n 's/^[[:space:]]*rtp_port_range[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' \
        "${dir}/settings.ini" 2>/dev/null | tail -1 | tr -d '[:space:]')"
    if [[ "$configured" =~ ^([0-9]+)-([0-9]+)$ ]]; then
        echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
    else
        echo "20000 20200"   # services/janus/install.sh 의 DEFAULT_RTP_RANGE
    fi
}
janus_sip_range() { jcfg_rtp_range "${PROJECT_ROOT}/services/janus/janus.plugin.sip.jcfg"; }
kamailio_media_range() {
    local v
    v="$(sed -n 's/^[[:space:]]*media_port_range[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' \
        "${PROJECT_ROOT}/services/kamailio/settings.ini" 2>/dev/null | tail -1 | tr -d '[:space:]')"
    if [[ "$v" =~ ^([0-9]+)-([0-9]+)$ ]]; then
        echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
    else
        echo "10200 19999"   # services/kamailio/install.sh 의 기본값
    fi
}

# settings.ini 의 값이 쓸 만한지 본다. 화면(lib/settings.js)이 이미 한 번
# 걸렀지만, 파일은 손으로도 고칠 수 있으므로 root 로 도는 이쪽에서 다시 본다.
SETTINGS_PROBLEMS=()
SETTINGS_PENDING=()
validate_settings() {
    SETTINGS_PROBLEMS=()
    SETTINGS_PENDING=()

    [[ -r "$SETTINGS_FILE" ]] \
        || SETTINGS_PENDING+=("settings.ini 가 없습니다: ${SETTINGS_FILE} — node ../../lib/settings.js --init . 로 뼈대를 만들거나 기본값으로 진행하세요")

    if [[ -n "$PUBLIC_IP" && ! "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
        SETTINGS_PROBLEMS+=("public_ip 가 IPv4 로 보이지 않습니다: ${PUBLIC_IP}")
    fi

    [[ -n "$REALM" ]] || SETTINGS_PROBLEMS+=("realm 이 비어 있습니다")

    if [[ ! "$LISTENING_PORT" =~ ^[0-9]{1,5}$ ]] || (( LISTENING_PORT < 1 || LISTENING_PORT > 65535 )); then
        SETTINGS_PROBLEMS+=("listening_port 가 올바른 포트가 아닙니다: ${LISTENING_PORT}")
    fi

    if [[ ! "$RELAY_PORT_RANGE" =~ ^[0-9]{4,5}-[0-9]{4,5}$ ]]; then
        SETTINGS_PROBLEMS+=("relay_port_range 형식이 맞지 않습니다 (예: 49160-49560): ${RELAY_PORT_RANGE}")
    else
        local rlo="${RELAY_PORT_RANGE%-*}" rhi="${RELAY_PORT_RANGE#*-}"
        (( rlo < rhi )) || SETTINGS_PROBLEMS+=("relay_port_range 는 시작이 끝보다 작아야 합니다: ${RELAY_PORT_RANGE}")
        (( rlo >= 1024 && rhi <= 65535 )) || SETTINGS_PROBLEMS+=("relay_port_range 는 1024~65535 안이어야 합니다: ${RELAY_PORT_RANGE}")

        local other lo hi label
        for label in "Janus WebRTC:$(janus_webrtc_range)" "Janus SIP:$(janus_sip_range)" "rtpengine/rtpproxy:$(kamailio_media_range)"; do
            other="${label#*:}"
            [[ -n "$other" ]] || continue
            lo="${other% *}"; hi="${other#* }"
            [[ -n "$lo" && -n "$hi" ]] || continue
            ranges_overlap "$rlo" "$rhi" "$lo" "$hi" \
                && SETTINGS_PROBLEMS+=("relay_port_range(${RELAY_PORT_RANGE}) 가 ${label%%:*}(${lo}-${hi}) 와 겹칩니다")
        done
    fi

    [[ ${#SETTINGS_PROBLEMS[@]} -eq 0 && ${#SETTINGS_PENDING[@]} -eq 0 ]]
}

# 저장한 값과 마지막으로 설치한 값이 다른가 = 사람이 --apply 를 해야 하는가.
report_settings_pending() {
    [[ -r "$APPLIED_FILE" ]] || {
        info "  (적용 기록이 아직 없습니다 — --apply 를 한 번 돌리면 이후로는 어긋남을 알 수 있습니다)"
        return 0
    }

    local key saved applied
    for key in public_ip realm relay_port_range listening_port; do
        case "$key" in
            public_ip)        saved="$PUBLIC_IP" ;;
            realm)            saved="$REALM" ;;
            relay_port_range) saved="$RELAY_PORT_RANGE" ;;
            listening_port)   saved="$LISTENING_PORT" ;;
        esac
        applied="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$APPLIED_FILE" | tail -1)"
        applied="${applied//[[:space:]]/}"
        [[ "$saved" == "$applied" ]] && continue
        pend "${key} 가 아직 반영되지 않았습니다: 설치본 '${applied}' → 저장한 값 '${saved}' (sudo $0 --apply)"
    done
}

# 실행 중인 것이 우리가 소유한 설정인가. Janus·Kamailio 와 같은 이유로 표식을
# 심어 둔다 — 손으로 고친 흔적과 우리가 설치한 것을 구별하기 위해서다.
CFG_MARKER="OWNED-BY-WEBSERVICES"

# ---------- 점검 ----------

report() {
    local problems=0

    info "coturn 패키지"
    if pkg_installed "$PKG"; then
        ok "설치됨 (dpkg)"
        command -v turnserver >/dev/null 2>&1 && ok "바이너리: $(command -v turnserver)"
    else
        pend "설치되지 않음 — sudo $0 --apply 가 apt 로 설치합니다"
    fi

    info ""
    info "systemd (패키지가 소유하는 유닛 — coturn.service)"
    if systemctl list-unit-files coturn.service &>/dev/null; then
        if [[ -r "$DEFAULT_FILE" ]] && grep -qE '^[[:space:]]*TURNSERVER_ENABLED[[:space:]]*=[[:space:]]*1' "$DEFAULT_FILE"; then
            ok "${DEFAULT_FILE} 의 TURNSERVER_ENABLED=1"
        else
            pend "${DEFAULT_FILE} 의 TURNSERVER_ENABLED 가 켜져 있지 않습니다 — 배포판 기본은 꺼짐입니다"
        fi
        systemctl is-enabled --quiet coturn 2>/dev/null \
            && ok "부팅 시 자동 기동 (enabled)" \
            || pend "enabled 가 아닙니다 — 재부팅하면 뜨지 않습니다"
        systemctl is-active --quiet coturn 2>/dev/null \
            && ok "구동 중" \
            || pend "구동 중이 아닙니다 (journalctl -u coturn -n 40)"
    else
        pend "coturn.service 유닛이 없습니다 — 패키지가 아직 설치되지 않았습니다"
    fi

    info ""
    info "설정 (${ETC_CFG})"
    if [[ ! -f "$ETC_CFG" ]]; then
        pend "설치되지 않음 — sudo $0 --apply"
    elif [[ ! -r "$ETC_CFG" ]]; then
        skip "읽을 수 없어 비교를 건너뜁니다 (권한)"
    else
        # 자리표시자가 채워지는(또는 지워지는) 자리는 키 기준으로 눌러 비교한다.
        report_config_diff "turnserver.conf" "sudo $0 --apply" \
            -n 's%^static-auth-secret=.*%static-auth-secret=«%' \
            -n 's%^realm=.*%realm=«%' \
            -n 's%^listening-port=.*%listening-port=«%' \
            -n 's%^min-port=.*%min-port=«%' \
            -n 's%^max-port=.*%max-port=«%' \
            -x 'external-ip' \
            "$ETC_CFG" "$TEMPLATE" \
            || problems=$((problems + 1))
    fi

    info ""
    info "비밀 (${SECRETS_DIR})"
    if [[ -f "$STATIC_AUTH_SECRET_FILE" ]]; then
        local perm; perm="$(stat -c '%a' "$STATIC_AUTH_SECRET_FILE")"
        if [[ "$perm" == "600" ]]; then
            ok "static-auth-secret: $(basename "$STATIC_AUTH_SECRET_FILE") (권한 600, 소유 $(stat -c '%U' "$STATIC_AUTH_SECRET_FILE"))"
        else
            warn "static-auth-secret 의 권한이 ${perm} 입니다 — 600 이어야 합니다"
            problems=$((problems + 1))
        fi
    else
        pend "static-auth-secret 없음 — sudo $0 --apply 가 만듭니다"
    fi

    info ""
    info "배포 설정 (settings.ini)"
    validate_settings || true
    if [[ ${#SETTINGS_PROBLEMS[@]} -eq 0 && ${#SETTINGS_PENDING[@]} -eq 0 ]]; then
        if [[ -n "$(settings_get public_ip '')" ]]; then
            ok "공인 IP: ${PUBLIC_IP} (이 서비스의 settings.ini)"
        elif [[ -n "$PUBLIC_IP" ]]; then
            ok "공인 IP: ${PUBLIC_IP} (services/janus/settings.ini 에서 물려받음)"
        else
            warn "공인 IP 가 없습니다 — Janus 에도 없습니다. LAN 전용으로 설치되며, 이 서비스를 만든 이유(셀룰러 모바일 NAT 통과)가 무효화됩니다"
            problems=$((problems + 1))
        fi
        ok "realm: ${REALM}"
        ok "릴레이 포트 범위: ${RELAY_PORT_RANGE}"
        ok "수신 포트: ${LISTENING_PORT}"
        report_settings_pending
    else
        local line
        for line in "${SETTINGS_PENDING[@]}"; do pend "$line"; done
        for line in "${SETTINGS_PROBLEMS[@]}"; do warn "$line"; done
        problems=$((problems + ${#SETTINGS_PROBLEMS[@]} + ${#SETTINGS_PENDING[@]}))
    fi

    info ""
    info "공유기 포트 포워딩 (이 장비는 공인 IP 가 없습니다 — ip -4 addr show 로 확인)"
    info "  UDP+TCP ${LISTENING_PORT}              → 이 장비 ${LISTENING_PORT}   (STUN/TURN 수신)"
    info "  UDP     ${RELAY_PORT_RANGE}        → 이 장비 ${RELAY_PORT_RANGE} (릴레이된 미디어)"
    info "  이미 열려 있는 Janus WebRTC 포워딩과는 별개입니다 — 겹치지 않는 범위이므로 추가로 열어야 합니다."

    info ""
    if [[ $problems -eq 0 ]]; then
        info "준비 완료. 설치하려면: sudo $0 --apply"
    else
        info "먼저 해결할 항목이 ${problems}개 있습니다. (위의 [--] / [!!])"
    fi
    return 0
}

# ---------- 설치 ----------

BACKUPS=()
restore_backups() {
    local b f
    for b in "${BACKUPS[@]:-}"; do
        [[ -f "$b" ]] || continue
        f="${b%.bak.*}"
        cp -p "$b" "$f"
        info "  되돌림: ${f}"
    done
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

# 영숫자 비밀을 만들어 파일에 넣는다. 이미 있으면 그대로 쓴다.
# services/janus/install.sh 의 ensure_secret 과 같은 관용구다.
ensure_secret() {
    local file="$1" label="$2"

    if [[ -s "$file" ]]; then
        info "  그대로 씀: ${file} (${label})"
        return 0
    fi

    command -v openssl >/dev/null || die "openssl 이 필요합니다 (비밀 생성)"
    install -d -m 700 "$SECRETS_DIR"
    openssl rand -hex 16 > "$file"
    chmod 600 "$file"
    info "  생성: ${file} (${label})"
}

# 패키지를 넣는다. 이미 있으면 아무것도 하지 않는다.
install_package() {
    if pkg_installed "$PKG"; then
        info "  이미 설치됨: ${PKG}"
        return 0
    fi
    info "  설치: ${PKG} (apt)"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$PKG"
}

# /etc/default/coturn 은 패키지가 소유한다 — 통째로 덮어쓰지 않고, 활성화
# 플래그 한 줄만 켠다. 배포판은 이 값을 주석 처리한 채(#TURNSERVER_ENABLED=1)
# 로 배포하므로, 패키지를 넣는 것만으로는 기동하지 않는다.
enable_default_file() {
    if [[ ! -f "$DEFAULT_FILE" ]]; then
        echo "TURNSERVER_ENABLED=1" > "$DEFAULT_FILE"
        info "  생성: ${DEFAULT_FILE} (TURNSERVER_ENABLED=1)"
        return 0
    fi

    backup "$DEFAULT_FILE"
    if grep -qE '^[[:space:]]*#?[[:space:]]*TURNSERVER_ENABLED[[:space:]]*=' "$DEFAULT_FILE"; then
        sed -i -E 's/^[[:space:]]*#?[[:space:]]*TURNSERVER_ENABLED[[:space:]]*=.*/TURNSERVER_ENABLED=1/' "$DEFAULT_FILE"
    else
        echo "TURNSERVER_ENABLED=1" >> "$DEFAULT_FILE"
    fi
    info "  갱신: ${DEFAULT_FILE} (TURNSERVER_ENABLED=1)"
}

write_config() {
    local secret="$1"

    backup "$ETC_CFG"
    sed -e "s|__LISTENING_PORT__|${LISTENING_PORT}|" \
        -e "s|__REALM__|${REALM}|" \
        -e "s|__STATIC_AUTH_SECRET__|${secret}|" \
        -e "s|__RELAY_PORT_RANGE_MIN__|${RELAY_PORT_RANGE%-*}|" \
        -e "s|__RELAY_PORT_RANGE_MAX__|${RELAY_PORT_RANGE#*-}|" \
        "$TEMPLATE" > "$ETC_CFG"

    # 공인 IP — 있으면 채우고, 없으면 그 줄을 지운다 (LAN 전용). 자리표시자가
    # 남으면 coturn 이 그 문자열을 주소로 알아듣는다 (services/janus 와 같은 함정).
    if [[ -n "$PUBLIC_IP" ]]; then
        # 사설 주소는 이 장비의 것을 그대로 쓴다 — coturn 이 자동으로 감지하는
        # 인터페이스 주소와 다르면 오히려 혼란을 준다. listening-ip 를 명시하지
        # 않았으므로(turnserver.conf 의 주석 참고) 여기서도 자동 감지에 맡기고
        # "공인IP/" 형태로 사설 쪽을 비워 두면 coturn 이 감지한 주소를 쓴다.
        sed -i "s|^external-ip=__PUBLIC_IP__|external-ip=${PUBLIC_IP}|" "$ETC_CFG"
    else
        sed -i '/^external-ip=__PUBLIC_IP__/d' "$ETC_CFG"
    fi

    if grep -nE '__[A-Z_]+__' "$ETC_CFG" >/dev/null; then
        echo
        grep -nE '__[A-Z_]+__' "$ETC_CFG" | sed 's/^/    /'
        rm -f "$ETC_CFG"
        restore_backups
        die "치환되지 않은 자리가 남았습니다 (위 목록). 설치를 취소했습니다."
    fi

    chown root:root "$ETC_CFG"
    chmod 644 "$ETC_CFG"
    info "  설치: ${ETC_CFG} (0644)"
}

apply() {
    require_root

    if ! validate_settings; then
        local line
        for line in "${SETTINGS_PENDING[@]}"; do echo "  [--]   $line" >&2; done
        for line in "${SETTINGS_PROBLEMS[@]}"; do echo "  [!!]   $line" >&2; done
        die "settings.ini 의 값으로는 설치할 수 없습니다 (위 목록). 아무것도 바꾸지 않았습니다."
    fi

    [[ -f "$TEMPLATE" ]] || die "템플릿이 없습니다: ${TEMPLATE}"

    if [[ -z "$PUBLIC_IP" ]]; then
        echo
        echo "⚠️  공인 IP 가 없습니다 (이 서비스에도, services/janus/settings.ini 에도)."
        echo "    LAN 전용으로 설치됩니다 — 셀룰러 모바일의 NAT 통과에는 쓸모가 없습니다."
        confirm "그래도 계속할까요?" || { echo "취소했습니다."; exit 0; }
    fi

    echo
    echo "다음을 설치합니다:"
    echo "  ${PKG} (apt, 이미 있으면 건너뜀)"
    echo "  ${ETC_CFG}   (listening-port=${LISTENING_PORT}, realm=${REALM}, 릴레이=${RELAY_PORT_RANGE})"
    echo "  ${DEFAULT_FILE}   (TURNSERVER_ENABLED=1)"
    echo "  ${STATIC_AUTH_SECRET_FILE}   (없으면 생성)"
    echo
    confirm "진행할까요?" || { echo "취소했습니다."; exit 0; }

    install_package

    local secret
    ensure_secret "$STATIC_AUTH_SECRET_FILE" "TURN REST API 정적 비밀"
    secret="$(head -1 "$STATIC_AUTH_SECRET_FILE" | tr -d '\r\n')"
    [[ -n "$secret" ]] || die "비밀 파일이 비어 있습니다: ${STATIC_AUTH_SECRET_FILE}"
    # 대시보드(pm2 사용자)가 상태를 읽을 수 있어야 한다 — janus/install.sh 와 같은 이유.
    if [[ -n "${SUDO_USER:-}" ]]; then
        chown -R "${SUDO_USER}:$(id -gn "$SUDO_USER")" "$SECRETS_DIR"
        info "  소유자: ${SUDO_USER} (대시보드가 읽어야 합니다)"
    fi

    write_config "$secret"
    enable_default_file

    systemctl daemon-reload
    systemctl reset-failed coturn 2>/dev/null || true
    systemctl enable --now coturn || true
    sleep 1

    if systemctl is-active --quiet coturn; then
        ok "coturn 구동 중"

        {
            echo "; install.sh --apply 가 마지막으로 설치한 값. 손으로 고치지 마세요."
            echo "public_ip = ${PUBLIC_IP}"
            echo "realm = ${REALM}"
            echo "relay_port_range = ${RELAY_PORT_RANGE}"
            echo "listening_port = ${LISTENING_PORT}"
        } > "$APPLIED_FILE"
        chmod 644 "$APPLIED_FILE"
        info "  적용 기록: ${APPLIED_FILE}"
    else
        warn "기동에 실패했습니다. 설정을 되돌립니다."
        restore_backups
        systemctl daemon-reload
        systemctl reset-failed coturn 2>/dev/null || true
        systemctl start coturn || true
        echo
        journalctl -u coturn -n 20 --no-pager 2>/dev/null | tail -20
        die "되돌렸습니다. 위 로그에서 원인을 확인하세요."
    fi

    echo
    echo "다음 단계 — 공유기 포트 포워딩 (이 장비는 공인 IP 가 없습니다):"
    echo "  UDP+TCP ${LISTENING_PORT}       → ${PUBLIC_IP:-<이 장비의 LAN 주소>}:${LISTENING_PORT}"
    echo "  UDP     ${RELAY_PORT_RANGE} → ${PUBLIC_IP:-<이 장비의 LAN 주소>}:${RELAY_PORT_RANGE}"
    echo "  (이미 열려 있는 Janus 의 WebRTC 포워딩과는 다른 범위입니다 — 추가로 열어야 합니다)"
    echo
    echo "⚠️  아직 아무 것도 이 TURN 서버를 쓰지 않습니다. Janus 의 nat: {} 블록과"
    echo "    모바일 앱의 iceServers 에 turn: 항목을 추가해야 실제로 쓰입니다."
    echo "    자세한 내용은 docs/plan.md 의 '아직 안 한 일' 을 보세요."
}

remove() {
    require_root

    if ! pkg_installed "$PKG" && [[ ! -f "$ETC_CFG" ]]; then
        info "설치되어 있지 않습니다."
        exit 0
    fi

    echo "coturn 을 멈추고 이 저장소가 설치한 설정을 걷어냅니다."
    echo "  - 패키지는 남깁니다 (지우는 것은 사람의 판단입니다: sudo apt remove coturn)"
    echo "  - ${SECRETS_DIR} 는 지우지 않습니다 (다시 설치할 때 같은 자격 증명 계산을 쓰기 위해서입니다)"
    confirm "계속할까요?" || { echo "취소했습니다."; exit 0; }

    systemctl disable --now coturn 2>/dev/null || true

    if [[ -f "$ETC_CFG" ]] && grep -q "$CFG_MARKER" "$ETC_CFG" 2>/dev/null; then
        backup "$ETC_CFG"
        rm -f "$ETC_CFG"
        info "  제거: ${ETC_CFG}"
    fi

    if [[ -f "$DEFAULT_FILE" ]]; then
        backup "$DEFAULT_FILE"
        sed -i -E 's/^[[:space:]]*TURNSERVER_ENABLED[[:space:]]*=.*/#TURNSERVER_ENABLED=1/' "$DEFAULT_FILE" || true
        info "  갱신: ${DEFAULT_FILE} (TURNSERVER_ENABLED 를 다시 끔)"
    fi

    ok "걷어냈습니다. 상태 확인: $0"
}

case "$MODE" in
    check)  report; check_finish ;;
    apply)  apply ;;
    remove) remove ;;
esac
