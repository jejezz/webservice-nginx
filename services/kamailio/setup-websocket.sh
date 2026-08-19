#!/usr/bin/env bash
#
# SIP over WebSocket (RFC 7118) 준비 상태를 점검하고, 필요한 배포판 패키지를 설치한다.
#
#   ./setup-websocket.sh                 점검만 한다 (아무것도 바꾸지 않음)
#   sudo ./setup-websocket.sh --install  모듈 패키지를 설치한다 (설정은 안 건드림)
#   sudo ./setup-websocket.sh --enable   WS 설정을 설치하고 kamailio 를 재시작한다
#   sudo ./setup-websocket.sh --disable  WS 설정을 걷어낸다
#
# 배포판 kamailio.cfg 는 한 줄도 고치지 않는다. 그 파일에는 WITH_WEBSOCKET 스위치가
# 없지만, WS handshake 를 처리할 event_route[xhttp:request] 와 xhttp.so 로드가 둘 다
# #!ifdef WITH_JSONRPC 아래에 있고 그 스위치가 꺼져 있어 자리가 비어 있다.
# 그래서 오버라이드 파일에서 직접 채운다. (검증 내용은 docs/websocket-plan.md)
#
# 파일 소유:
#   install.sh          → kamailio-local.cfg      (digest 인증)
#   setup-websocket.sh  → kamailio-websocket.cfg  (WS 전송)
# 둘은 독립이며 순서 제약도 없다. 다만 --enable 은 local cfg 에 import_file 줄이
# 있어야 효과가 있으므로 그것을 확인한다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MAIN_CFG="/etc/kamailio/kamailio.cfg"
LOCAL_CFG="/etc/kamailio/kamailio-local.cfg"
WS_CFG_INSTALLED="/etc/kamailio/kamailio-websocket.cfg"
WS_TEMPLATE="${SCRIPT_DIR}/kamailio-websocket.cfg"
# WS 설정의 listen= 과 nginx-conf/service.ini 의 ports 와 같은 값이어야 한다.
WS_PORT=5080

# Kamailio 5.5 에서 SIP over WS 에 필요한 모듈.
#   websocket  WS handshake 와 프레이밍
#   xhttp      handshake 가 올라타는 HTTP 처리 (websocket 이 의존)
#   nathelper  WS 단말의 NAT 처리
#   tls        Kamailio 가 직접 WSS 를 끊을 때만. nginx 가 TLS 를 끊으면 불필요
REQUIRED_MODULES=(websocket xhttp)
# 착신 푸시(docs/incoming-call.md)에 필요한 것들. WS 전송만 쓸 때는 없어도 된다.
OPTIONAL_MODULES=(tls nathelper rtpengine tsilo http_client)

# 모듈 → 배포판 패키지
declare -A MODULE_PACKAGE=(
    [websocket]=kamailio-websocket-modules
    [tls]=kamailio-tls-modules
    [xhttp]=kamailio-extra-modules
    [nathelper]=kamailio
    [rtpengine]=kamailio
    [tsilo]=kamailio
    [http_client]=kamailio-utils-modules
)

MODE="check"
ASSUME_YES=false

for arg in "$@"; do
    case "$arg" in
        --install)  MODE="install" ;;
        --enable)   MODE="enable" ;;
        --disable)  MODE="disable" ;;
        --check)    MODE="check" ;;
        --yes|-y)   ASSUME_YES=true ;;
        *) echo "Unknown option: $arg"
           echo "Usage: $0 [--check|--install|--enable|--disable] [--yes]"; exit 1 ;;
    esac
done

ok()   { echo "  [ok]   $*"; }
no()   { echo "  [--]   $*"; }
warn() { echo "  [!!]   $*"; }
info() { echo "$*"; }
die()  { echo "오류: $*" >&2; exit 1; }

confirm() {
    $ASSUME_YES && return 0
    read -r -p "$1 [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

require_root() {
    [[ "$(id -u)" -eq 0 ]] || die "이 동작은 root 권한이 필요합니다. sudo 로 다시 실행하세요."
}

# 실제로 구동 중인 바이너리. PATH 의 kamailio 는 소스빌드판일 수 있어 쓰지 않는다.
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

# 구동 중인 바이너리에 맞는 모듈 디렉토리.
module_dir() {
    local bin; bin="$(running_binary)"
    case "$bin" in
        /usr/local/sbin/*) echo "/usr/local/lib64/kamailio/modules" ;;
        *)                 echo "/usr/lib/x86_64-linux-gnu/kamailio/modules" ;;
    esac
}

has_module() { [[ -f "$(module_dir)/$1.so" ]]; }

# 패키지가 저장소에 있는가 (설치 가능한가)
package_available() {
    local cand
    cand="$(apt-cache --no-generate policy "$1" 2>/dev/null | awk '/Candidate:/{print $2}')"
    [[ -n "$cand" && "$cand" != "(none)" ]]
}

missing_packages() {
    local -A want=()
    local m
    for m in "${REQUIRED_MODULES[@]}"; do
        has_module "$m" || want["${MODULE_PACKAGE[$m]}"]=1
    done
    printf '%s\n' "${!want[@]}"
}

# ---------- 점검 ----------

report() {
    local problems=0

    info "Kamailio"
    if systemctl is-active --quiet kamailio; then
        local bin; bin="$(running_binary)"
        ok "서비스 동작 중 — ${bin:-경로 확인 불가}"
        [[ -n "$bin" ]] && ok "버전: $("$bin" -v 2>/dev/null | sed -n '1s/version: //p')"
        ok "모듈 디렉토리: $(module_dir)"
    else
        warn "서비스가 동작하지 않습니다 (systemctl status kamailio)"
        problems=$((problems + 1))
    fi

    info ""
    info "필수 모듈"
    local m
    for m in "${REQUIRED_MODULES[@]}"; do
        if has_module "$m"; then
            ok "$m"
        else
            local pkg="${MODULE_PACKAGE[$m]}"
            if package_available "$pkg"; then
                no "$m — 없음. 패키지 ${pkg} 로 설치할 수 있습니다"
            else
                warn "$m — 없음. 패키지 ${pkg} 가 저장소에 없습니다 (소스 빌드 필요)"
            fi
            problems=$((problems + 1))
        fi
    done

    info ""
    info "선택 모듈"
    for m in "${OPTIONAL_MODULES[@]}"; do
        has_module "$m" && ok "$m" || no "$m — 없음 (${MODULE_PACKAGE[$m]})"
    done

    info ""
    info "리스닝 소켓"
    # ss 는 root 가 아니면 프로세스 이름을 보여주지 않는다. 그때는 "없다" 가 아니라
    # "모른다" 로 보고해야 한다 — 이전 판은 둘을 구별하지 못해, TCP 5060 이 멀쩡히
    # 열려 있는데도 "TCP 소켓 없음" 이라고 잘못 알렸다.
    if [[ "$(id -u)" -ne 0 ]]; then
        no "권한이 없어 확인할 수 없습니다 — sudo $0 로 다시 실행하세요"
    else
        local tcp_socks
        ss -lnptu 2>/dev/null | awk '/kamailio/{print "  [ok]   "$1"  "$5}' | sort -u
        tcp_socks="$(ss -lnpt 2>/dev/null | grep -c 'kamailio' || true)"
        if [[ "${tcp_socks:-0}" -gt 0 ]]; then
            ok "TCP 소켓 있음 — WebSocket 이 올라탈 수 있습니다"
        else
            no "TCP 소켓 없음 — WebSocket 은 TCP 위에서 동작하므로 listen 지시자가 필요합니다"
            problems=$((problems + 1))
        fi
    fi

    info ""
    info "설정"
    if [[ -r "$MAIN_CFG" ]]; then
        # 실제 loadmodule 은 kamailio-websocket.cfg 에 있으므로 오버라이드 파일도
        # 본다. 그런데 그 파일은 0640 root:kamailio 라 일반 사용자는 못 읽는다.
        # 읽지 못한 것을 "없다" 로 보고하면 안 된다 — 소켓 검사와 같은 이유다.
        if [[ -f "$WS_CFG_INSTALLED" && ! -r "$WS_CFG_INSTALLED" ]]; then
            no "websocket.so 로드 여부 확인 불가 (root 권한 필요) — sudo $0"
        elif grep -qhE '^\s*loadmodule\s+"websocket\.so"' \
             "$MAIN_CFG" "$LOCAL_CFG" "$WS_CFG_INSTALLED" 2>/dev/null; then
            ok "websocket.so 를 로드합니다"
        else
            no "websocket.so 를 로드하지 않습니다"
            problems=$((problems + 1))
        fi
        # 배포판 설정에는 WITH_WEBSOCKET 스위치가 없다. 대신 WITH_JSONRPC 가 꺼져 있어
        # xhttp 로드와 event_route[xhttp:request] 자리가 비어 있으므로, 오버라이드
        # 파일에서 직접 채울 수 있다. (docs/websocket-plan.md 에 검증 내용)
        if grep -qE '^\s*#!define\s+WITH_JSONRPC' "$MAIN_CFG" /etc/kamailio/kamailio-local.cfg 2>/dev/null; then
            warn "WITH_JSONRPC 가 켜져 있습니다 — event_route[xhttp:request] 가 충돌합니다"
            problems=$((problems + 1))
        else
            ok "WITH_JSONRPC 꺼짐 — event_route[xhttp:request] 자리가 비어 있습니다"
        fi

        if [[ -f "$WS_CFG_INSTALLED" ]]; then
            ok "WS 설정 설치됨: ${WS_CFG_INSTALLED}"
            if verify_ws; then
                verify_handshake || problems=$((problems + 1))
            else
                problems=$((problems + 1))
            fi
        else
            no "WS 설정 없음 — sudo $0 --enable 로 설치합니다"
            problems=$((problems + 1))
        fi
    else
        warn "설정을 읽을 수 없습니다: ${MAIN_CFG}"
    fi

    info ""
    info "라우팅 선언"
    local ini="${SCRIPT_DIR}/nginx-conf/service.ini"
    if grep -qE '^\s*enabled\s*=\s*false' "$ini" 2>/dev/null; then
        no "nginx-conf/service.ini 가 enabled = false — 준비가 끝나면 true 로 바꾸세요"
    else
        ok "nginx-conf/service.ini 활성"
    fi

    info ""
    if [[ $problems -eq 0 ]]; then
        info "모듈과 소켓은 준비됐습니다. 남은 것은 설정입니다 — docs/websocket-plan.md"
    else
        info "남은 항목이 ${problems}개 있습니다. (위의 [--] / [!!])"
        info "패키지만 설치하려면: sudo $0 --install"
        info "처음부터 세우는 전체 순서는: ./bootstrap.sh"
    fi
    return 0
}

# ---------- 설치 ----------

install_packages() {
    require_root

    local pkgs=()
    mapfile -t pkgs < <(missing_packages)
    # mapfile 은 빈 줄 하나를 남길 수 있다
    local filtered=()
    local p
    for p in "${pkgs[@]}"; do [[ -n "$p" ]] && filtered+=("$p"); done
    pkgs=("${filtered[@]}")

    if [[ ${#pkgs[@]} -eq 0 ]]; then
        info "필요한 모듈이 모두 설치되어 있습니다."
        return 0
    fi

    local unavailable=()
    for p in "${pkgs[@]}"; do
        package_available "$p" || unavailable+=("$p")
    done
    if [[ ${#unavailable[@]} -gt 0 ]]; then
        die "저장소에 없는 패키지가 있습니다: ${unavailable[*]}
소스 빌드가 필요합니다. docs/websocket-plan.md 참고."
    fi

    echo
    echo "다음 패키지를 설치합니다:"
    printf '  %s\n' "${pkgs[@]}"
    echo
    echo "패키지 설치만 합니다 — 설정 파일과 실행 중인 서비스는 건드리지 않습니다."
    echo
    echo "참고: 이것은 **WebSocket 전송에 필요한 것만** 설치합니다."
    echo "      착신 푸시(http_client)까지 포함한 전체는 ./bootstrap.sh --install 입니다."
    echo "모듈이 생겨도 설정에서 loadmodule 하지 않으면 Kamailio 동작은 그대로입니다."
    echo
    confirm "진행할까요?" || { echo "취소했습니다."; exit 0; }

    # 구동 중인 바이너리가 소스빌드판이면 배포판 모듈은 쓰이지 않는다.
    local bin; bin="$(running_binary)"
    if [[ "$bin" == /usr/local/* ]]; then
        warn "구동 중인 바이너리가 소스빌드판입니다: ${bin}"
        warn "배포판 패키지의 모듈은 $(module_dir) 에 설치되어 그쪽에서 쓰이지 않습니다."
        confirm "그래도 설치할까요?" || { echo "취소했습니다."; exit 0; }
    fi

    apt-get install -y "${pkgs[@]}"

    echo
    info "설치 후 상태:"
    local m
    for m in "${REQUIRED_MODULES[@]}"; do
        has_module "$m" && ok "$m" || warn "$m — 여전히 없습니다"
    done

    echo
    echo "다음 단계는 설정입니다. 배포판 kamailio.cfg 로는 켤 수 없으므로"
    echo "어떻게 소유할지 먼저 정해야 합니다 — docs/websocket-plan.md"
}

# ---------- 설정 설치 ----------

backup() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    local dest="${file}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -p "$file" "$dest"
    info "  백업: ${dest}"
}

# 설치하기 전에 검사한다.
#
# 임시 디렉토리에 배포판 설정과 지금 설치된 오버라이드를 복사하고, 그 안에서만
# WS 설정을 얹어 kamailio -c 를 돌린다. /etc 를 건드리지 않으므로 실패해도
# 실행 중인 서비스에 아무 영향이 없다.
#
# kamailio -c 는 문법과 **모듈 로딩**까지 본다. websocket.so 가 없거나
# event_route 가 충돌하면 여기서 걸린다.
validate_config() {
    # trap ... RETURN 을 쓰지 않는다. bash 의 trap 은 함수 지역이 아니라 전역이라
    # 이 함수가 끝난 뒤에도 남아 있다가, 호출한 함수가 반환할 때 다시 실행된다.
    # 그때는 아래 tmp 가 이미 사라진 뒤라 set -u 에 걸려 "unbound variable" 로
    # 죽는다. 설치는 다 끝난 뒤에 마지막 줄에서 실패하는 형태였다.
    local tmp bin rc
    tmp="$(mktemp -d)"

    cp "$MAIN_CFG" "$tmp/kamailio.cfg"
    cp "$LOCAL_CFG" "$tmp/kamailio-local.cfg"
    cp "$WS_TEMPLATE" "$tmp/kamailio-websocket.cfg"

    # ⚠️ 반드시 임시 디렉토리를 CWD 로 두고 실행한다.
    #
    # Kamailio 의 import_file 은 **CWD 기준**으로 상대 경로를 푼다. CWD 가 저장소
    # 디렉토리면 거기 있는 kamailio-local.cfg(치환 전 템플릿)를 읽어, 검사하려던
    # 임시 사본이 아니라 엉뚱한 파일을 검사한다. 그러면 이 사전 검사가
    # 아무것도 지켜 주지 못한다. 실제로 그 상태였다.
    bin="$(running_binary)"; bin="${bin:-/usr/sbin/kamailio}"
    if ( cd "$tmp" && "$bin" -c -f kamailio.cfg ) >"$tmp/out" 2>&1; then
        rm -rf "$tmp"
        return 0
    fi
    echo
    tail -20 "$tmp/out"
    rm -rf "$tmp"
    return 1
}

# 설치 후 실제로 HTTP 응답이 오는지 본다.
#
# 이 검사가 있어야 하는 이유: tcp_accept_no_cl 이 빠지면 Kamailio 는 포트를 열고
# 프로세스도 정상인데 Content-Length 없는 요청에 아무 응답을 하지 않는다.
# WebSocket handshake 가 바로 그 형태(CL 없는 GET)이므로 WS 가 통째로 안 되는데,
# systemctl 로는 멀쩡해 보인다.
verify_ws() {
    local code
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WS_PORT}/health" 2>/dev/null)"
    code="${code:-000}"
    if [[ "$code" == "200" ]]; then
        ok "HTTP 응답 확인: /health → 200 (Content-Length 없는 GET 처리됨)"
        return 0
    fi
    warn "/health 가 응답하지 않습니다 (code=${code})"
    warn "  tcp_accept_no_cl=yes 가 빠졌을 때 나타나는 증상입니다."
    warn "  이 상태에서는 WebSocket handshake 도 되지 않습니다."
    return 1
}

# 진짜 WebSocket handshake 를 해 본다.
#
# /health 가 200 이라고 WS 가 되는 것은 아니다 — 둘 다 event_route[xhttp:request]
# 를 타지만 ws_handle_handshake() 는 websocket.so 가 제대로 올라와야 동작한다.
# 여기까지 확인해야 "WS 가 된다" 고 말할 수 있다.
#
# RFC 7118 은 서브프로토콜 'sip' 을 요구하므로 그것까지 함께 본다.
verify_handshake() {
    local out
    # head 를 파이프로 물리지 않는다 (pipefail + SIGPIPE). 전부 받고 잘라 쓴다 —
    # -m 3 이 있으므로 무한정 받지 않는다.
    out="$(curl -s -i -m 3 -N \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        -H 'Sec-WebSocket-Protocol: sip' \
        "http://127.0.0.1:${WS_PORT}/" 2>/dev/null || true)"

    if grep -q '101 Switching Protocols' <<<"$out" \
       && grep -qi 'Sec-WebSocket-Protocol: *sip' <<<"$out"; then
        ok "WebSocket handshake 확인: 101 Switching Protocols (서브프로토콜 sip)"
        return 0
    fi
    warn "WebSocket handshake 실패"
    [[ -n "$out" ]] && printf '%s\n' "$out" | sed -n '1,5p;s/^/         /p' 
    return 1
}

enable_ws() {
    require_root

    [[ -f "$WS_TEMPLATE" ]] || die "템플릿이 없습니다: ${WS_TEMPLATE}"
    [[ -f "$LOCAL_CFG" ]] || die "인증 설정이 먼저 설치돼 있어야 합니다: ${LOCAL_CFG}
  sudo ./install.sh --apply"

    local m
    for m in "${REQUIRED_MODULES[@]}"; do
        has_module "$m" || die "모듈이 없습니다: ${m}
  sudo $0 --install 을 먼저 실행하세요."
    done

    # local cfg 가 WS 파일을 읽어 들이는가. 없으면 설치해도 효과가 없다.
    if ! grep -q 'kamailio-websocket.cfg' "$LOCAL_CFG"; then
        die "설치된 ${LOCAL_CFG} 에 import_file \"kamailio-websocket.cfg\" 가 없습니다.
이 저장소의 kamailio-local.cfg 에는 그 줄이 있으므로, 인증 설정을 다시 설치하세요:
  sudo ./install.sh --apply"
    fi

    info "설치 전 검사 (임시 디렉토리, /etc 는 건드리지 않음)"
    if validate_config; then
        ok "kamailio -c 통과"
    else
        die "설정 검사에 실패했습니다. 위 로그를 확인하세요. 아무것도 설치하지 않았습니다."
    fi

    echo
    echo "다음을 설치합니다:"
    echo "  ${WS_CFG_INSTALLED}"
    echo
    echo "적용하면 바뀌는 것:"
    echo "  - tcp:127.0.0.1:5080 에서 WebSocket handshake 를 받습니다"
    echo "  - /health 에 JSON 으로 응답합니다"
    echo "  - WITH_NAT 이 켜집니다 — WS 뿐 아니라 기존 UDP 단말의 처리도 바뀝니다"
    echo "    (nathelper / rtpengine / rtpproxy 모듈이 함께 로드됩니다)"
    echo
    confirm "진행할까요?" || { echo "취소했습니다."; exit 0; }

    backup "$WS_CFG_INSTALLED"
    install -o root -g kamailio -m 640 "$WS_TEMPLATE" "$WS_CFG_INSTALLED" 2>/dev/null \
        || install -o root -g root -m 640 "$WS_TEMPLATE" "$WS_CFG_INSTALLED"
    info "  설치: ${WS_CFG_INSTALLED} (0640)"

    systemctl restart kamailio || true
    sleep 5

    if systemctl is-active --quiet kamailio; then
        ok "kamailio 재시작 완료"
        if verify_ws; then
            verify_handshake || warn "설정은 설치됐지만 WS handshake 가 되지 않습니다."
        else
            warn "설정은 설치됐지만 위 문제를 해결해야 WS 가 동작합니다."
        fi
    else
        warn "기동에 실패했습니다. 설치한 설정을 걷어냅니다."
        rm -f "$WS_CFG_INSTALLED"
        systemctl restart kamailio || true
        sleep 3
        systemctl is-active --quiet kamailio \
            && info "  이전 상태로 복구했습니다. SIP 서비스는 살아 있습니다." \
            || warn "  복구도 실패했습니다. journalctl -u kamailio -n 40 을 확인하세요."
        echo
        journalctl -u kamailio -n 15 --no-pager 2>/dev/null | tail -15
        die "설정을 되돌렸습니다. 위 로그에서 원인을 확인하세요."
    fi

    echo
    echo "확인:"
    echo "  ss -lnpt | grep 5080"
    echo "  curl -s http://127.0.0.1:5080/health"
    echo
    echo "다음 단계 — nginx-conf/service.ini 를 enabled = true 로 바꾸고"
    echo "  ./nginx/install_nginx_stack.sh --check"
    echo "  sudo ./nginx/install_nginx_stack.sh --skip-install"
}

disable_ws() {
    require_root

    [[ -f "$WS_CFG_INSTALLED" ]] || { info "설치되어 있지 않습니다: ${WS_CFG_INSTALLED}"; exit 0; }

    echo "제거하면 WebSocket 수신과 WITH_NAT 이 함께 꺼집니다."
    echo "인증 설정(kamailio-local.cfg)은 그대로 둡니다."
    confirm "계속할까요?" || { echo "취소했습니다."; exit 0; }

    backup "$WS_CFG_INSTALLED"
    rm -f "$WS_CFG_INSTALLED"
    info "  제거: ${WS_CFG_INSTALLED}"

    systemctl restart kamailio
    sleep 3
    systemctl is-active --quiet kamailio && ok "kamailio 재시작 완료" \
        || die "재시작 실패 — journalctl -u kamailio -n 40"
}

case "$MODE" in
    check)   report ;;
    install) install_packages ;;
    enable)  enable_ws ;;
    disable) disable_ws ;;
esac
