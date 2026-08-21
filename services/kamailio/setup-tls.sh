#!/usr/bin/env bash
#
# SIP over TLS 준비 상태를 점검하고 설정을 설치한다.
# nginx 의 stream 모듈이 TLS 를 끊고 Kamailio 로 평문 TCP 를 넘긴다.
#
#   ./setup-tls.sh                 점검만 한다 (아무것도 바꾸지 않음)
#   sudo ./setup-tls.sh --enable   stream 설정을 설치하고 nginx 를 reload 한다
#   sudo ./setup-tls.sh --disable  stream 설정을 걷어낸다
#
#   [단말] ──TLS──▶ [nginx stream :5061] ──평문 TCP──▶ [kamailio 127.0.0.1:5060]
#
# --- 왜 필요한가 ---
#
# 모바일 앱이 PJSIP 기반인데 PJSIP 에는 WebSocket 전송이 없다. nginx 가 끊어 주는
# wss://…/sip/ 경로를 그 앱은 쓸 수 없으므로, 네이티브 SIP UA 용 입구를 따로 연다.
# WS 경로는 그대로 둔다 — 둘은 독립이다.
#
# --- 왜 Kamailio 가 직접 끊지 않는가 ---
#
# Kamailio 5.5.4 + OpenSSL 3.0.2 는 tls 모듈이 기동 중에 힙을 깨뜨린다.
# 자세한 내용은 nginx-sip-tls.conf 머리말과 kamailio-tls.cfg 를 보라.
# **Kamailio 설정은 이 스크립트가 건드리지 않는다** — 이미 tcp 5060 을 듣고 있고,
# 그것으로 충분하다.
#
# 파일 소유:
#   install.sh          → kamailio.cfg · kamailio-local.cfg   (포크 · 인증)
#   setup-websocket.sh  → kamailio-websocket.cfg              (WS 전송)
#   setup-tls.sh        → /etc/nginx/streams-enabled/…        (TLS 입구)
#
# ⚠️ 이 스크립트만 nginx 설정을 직접 만진다. 다른 서비스는 nginx-conf/*.ini 에
#    선언하고 nginx/generate_nginx_conf.py 가 모아 주지만, 그 스키마는 http
#    라우트만 다룬다. stream 은 nginx.conf **최상위**에 있어야 해서 생성기의
#    출력 위치(conf.d/, http 블록 안)에 담을 수 없다. 쓰는 서비스가 하나뿐이라
#    생성기를 넓히지 않고 여기서 소유한다. 둘 이상이 필요해지면 그때 옮긴다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

LOCAL_CFG="/etc/kamailio/kamailio-local.cfg"

STREAM_TEMPLATE="${SCRIPT_DIR}/nginx-sip-tls.conf"
STREAM_DIR="/etc/nginx/streams-enabled"
STREAM_CONF="${STREAM_DIR}/kamailio-sip-tls.conf"
NGINX_CONF="/etc/nginx/nginx.conf"

# nginx.conf 최상위에 넣는 블록.
#
# ⚠️ **stream { } 로 감싸야 합니다.** streams-enabled 안의 파일은 server 블록만
#    담는데, server 는 stream(또는 http) 안에서만 허용됩니다. 처음에 include 만
#    넣었다가 이렇게 걸렸습니다.
#
#      nginx: [emerg] "server" directive is not allowed here
#
#    감싸는 쪽을 여기 두는 이유: 파일마다 stream 을 열면 블록이 여러 개가 되는데
#    nginx 는 stream 블록을 하나만 허용합니다. 여기서 한 번만 열고 안에서
#    파일들을 include 하면 나중에 서비스가 늘어도 그대로 됩니다.
#
#    ⚠️ 다른 곳에서 이미 stream 블록을 열었다면 충돌합니다. nginx -t 가 잡습니다.
MARK_BEGIN="# >>> SIP over TLS — services/kamailio/setup-tls.sh"
MARK_END="# <<< SIP over TLS — services/kamailio/setup-tls.sh"

# nginx 의 http 쪽과 같은 인증서. nginx master 는 root 라 원본을 그대로 읽는다.
SRC_CERT="${PROJECT_ROOT}/nginx/cert/server/server.crt"
SRC_KEY="${PROJECT_ROOT}/nginx/cert/server/server.key"
SRC_CA="${PROJECT_ROOT}/nginx/cert/ca/ca.crt"

TLS_PORT=5061
# Kamailio 가 평문 SIP 를 듣는 곳. 여기로 넘긴다.
BACKEND="127.0.0.1:5060"

# 실패한 Kamailio tls 모듈 시도가 남긴 것들. 이 방식에서는 쓰지 않는다.
STALE_KAMAILIO_TLS=(/etc/kamailio/tls.cfg /etc/kamailio/tls)

MODE="check"
ASSUME_YES=false

for arg in "$@"; do
    case "$arg" in
        --enable)   MODE="enable" ;;
        --disable)  MODE="disable" ;;
        --check)    MODE="check" ;;
        --yes|-y)   ASSUME_YES=true ;;
        *) echo "Unknown option: $arg"
           echo "Usage: $0 [--check|--enable|--disable] [--yes]"; exit 1 ;;
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

# nginx 가 stream 모듈을 로드했는가. 없으면 이 설정이 문법 오류가 된다.
has_stream_module() {
    nginx -V 2>&1 | grep -q -- '--with-stream' && return 0
    # Ubuntu 는 동적 모듈로 넣고 modules-enabled 에서 로드한다.
    #
    # ⚠️ -R 이어야 한다. modules-enabled 안은 modules-available 을 가리키는
    #    심볼릭 링크뿐인데, grep -r 은 재귀 중 만난 심볼릭 링크를 따라가지 않는다.
    #    -r 로 두었더니 모듈이 있는데도 "없습니다" 가 나왔다.
    grep -Rqs "ngx_stream_module" /etc/nginx/modules-enabled/ 2>/dev/null
}

# TLS 를 올릴 주소. 값을 새로 정하지 않고 설치된 kamailio-local.cfg 에서 읽어온다
# — SIP 와 TLS 입구가 다른 주소를 가리키는 사고를 막기 위해서다.
listen_addr() {
    [[ -r "$LOCAL_CFG" ]] || return 1
    sed -n 's/^listen=udp:\([0-9.]*\):5060.*/\1/p' "$LOCAL_CFG" 2>/dev/null \
        | grep -v '^127\.0\.0\.1$' | head -1
}

# 검사에 쓸 주소.
#
# listen_addr() 는 kamailio-local.cfg(0640 root:kamailio)를 읽으므로 sudo 없이는
# 실패한다. 그때 127.0.0.1 로 넘어가면 리스너가 LAN 주소에만 있어 연결이 거부되고,
# **TLS 가 멀쩡한데 "핸드셰이크 실패" 라고 보고한다.** 실제로 그랬다.
# 그래서 설정을 못 읽으면 열려 있는 소켓에서 주소를 얻는다.
probe_addr() {
    local a
    a="$(listen_addr 2>/dev/null || true)"
    [[ -n "$a" ]] && { printf '%s' "$a"; return; }
    a="$(ss -lnt 2>/dev/null | awk -v p=":${TLS_PORT}" '$4 ~ p"$" {print $4}' | head -1)"
    a="${a%:*}"
    printf '%s' "${a:-127.0.0.1}"
}

# 인증 realm 이자 From/To 도메인. 이것도 새로 정하지 않고 설치된 설정에서 읽는다.
sip_domain() {
    [[ -r "$LOCAL_CFG" ]] || return 1
    sed -n 's/^alias=\(.*\)$/\1/p' "$LOCAL_CFG" 2>/dev/null | head -1
}

# kamailio-local.cfg 는 0640 root:kamailio 다. 점검을 sudo 없이 돌리는 것이 기본
# 사용법이므로, 못 읽는 것과 없는 것을 구분해야 한다. 구분하지 않으면 거짓 보고가
# 나가고 그것을 믿고 install.sh --apply 를 다시 돌리게 된다.
local_cfg_state() {
    [[ -e "$LOCAL_CFG" ]] || { echo "missing"; return; }
    [[ -r "$LOCAL_CFG" ]] && echo "readable" || echo "unreadable"
}

cert_days_left() {
    local file="$1" end now
    [[ -r "$file" ]] || return 0
    end="$(openssl x509 -in "$file" -noout -enddate 2>/dev/null | cut -d= -f2)" || return 0
    [[ -n "$end" ]] || return 0
    end="$(date -d "$end" +%s 2>/dev/null)" || return 0
    now="$(date +%s)"
    echo $(( (end - now) / 86400 ))
}

# 진짜 TLS 핸드셰이크를 해 본다. 포트가 열려 있다고 되는 것이 아니다.
# 사설 CA 이므로 -CAfile 로 검증한다 — 단말도 같은 CA 를 신뢰해야 붙는다.
verify_tls() {
    local addr cn out
    addr="$(probe_addr)"
    [[ -r "$SRC_CA" ]] || { warn "CA 를 읽을 수 없어 검증을 건너뜁니다: $SRC_CA"; return 1; }

    cn="$(openssl x509 -in "$SRC_CERT" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p')"
    out="$(echo | timeout 10 openssl s_client -connect "${addr}:${TLS_PORT}" \
            -CAfile "$SRC_CA" ${cn:+-servername "$cn"} 2>&1 || true)"

    if grep -q 'Verify return code: 0 (ok)' <<<"$out"; then
        # "New, TLSv1.3, Cipher is ..." 를 쓴다. SSL-Session 블록의 Protocol 줄은
        # 연결이 먼저 닫히면 출력되지 않아 빈 괄호가 찍혔다.
        ok "TLS 핸드셰이크 확인: 인증서 검증 통과 ($(sed -n 's/^New, \(TLS[^,]*\), Cipher is \(.*\)$/\1 \2/p' <<<"$out" | head -1))"
        return 0
    fi
    warn "TLS 핸드셰이크 실패 (${addr}:${TLS_PORT})"
    grep -E 'Verify return code|verify error|connect:|errno' <<<"$out" | head -4 | sed 's/^/         /'
    return 1
}

# TLS 위로 진짜 SIP 를 한 번 보내 본다.
#
# 핸드셰이크가 됐다고 SIP 가 되는 것은 아니다. 넘겨받은 Kamailio 가 살아 있어야
# 하고, 응답이 같은 연결로 되돌아와야 한다. 여기까지 봐야 "SIP over TLS 가 된다"
# 고 말할 수 있다 — setup-websocket.sh 가 101 까지 확인하는 것과 같은 이유다.
#
# OPTIONS 를 쓰는 이유: 등록도 인증도 필요 없고 상태를 남기지 않는다.
verify_sip() {
    local addr cn out tag dom
    addr="$(probe_addr)"
    dom="$(sip_domain || true)"; dom="${dom:-$addr}"
    cn="$(openssl x509 -in "$SRC_CERT" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p')"
    tag="probe$$"

    # SIP over TCP 는 CRLF 와 Content-Length 를 요구한다. printf 로 정확히 만든다.
    out="$(printf 'OPTIONS sip:%s SIP/2.0\r\nVia: SIP/2.0/TLS %s:39999;branch=z9hG4bK-%s;rport\r\nMax-Forwards: 70\r\nFrom: <sip:probe@%s>;tag=%s\r\nTo: <sip:%s>\r\nCall-ID: %s@setup-tls\r\nCSeq: 1 OPTIONS\r\nContact: <sip:probe@%s:39999;transport=tls>\r\nUser-Agent: setup-tls probe\r\nContent-Length: 0\r\n\r\n' \
            "$dom" "$addr" "$tag" "$dom" "$tag" "$dom" "$tag" "$addr" \
        | timeout 8 openssl s_client -quiet -connect "${addr}:${TLS_PORT}" \
            -CAfile "$SRC_CA" ${cn:+-servername "$cn"} 2>/dev/null || true)"

    if grep -q '^SIP/2.0 ' <<<"$out"; then
        ok "SIP 응답 확인: $(head -1 <<<"$out" | tr -d '\r')"
        # Kamailio 가 보는 소스가 127.0.0.1 인 것은 이 구조의 정상 동작이다.
        grep -qE 'received=127\.0\.0\.1' <<<"$out" \
            && info "         (Kamailio 가 보는 소스는 127.0.0.1 — nginx 가 끊으므로 정상)"
        return 0
    fi
    warn "TLS 는 붙었지만 SIP 응답이 없습니다"
    warn "  ${BACKEND} 의 Kamailio 가 살아 있는지 확인하세요."
    [[ -n "$out" ]] && printf '%s\n' "$out" | head -3 | sed 's/^/         /'
    return 1
}

stale_present() {
    local p
    for p in "${STALE_KAMAILIO_TLS[@]}"; do [[ -e "$p" ]] && return 0; done
    return 1
}

nginx_conf_has_block() { grep -qF "$MARK_BEGIN" "$NGINX_CONF" 2>/dev/null; }

add_include_block() {
    backup "$NGINX_CONF"
    {
        printf '\n%s\n' "$MARK_BEGIN"
        printf 'stream {\n    include %s/*.conf;\n}\n' "$STREAM_DIR"
        printf '%s\n' "$MARK_END"
    } >> "$NGINX_CONF"
    info "  추가: ${NGINX_CONF} 에 stream 블록"
}

# 표시 블록을 걷어낸다.
#
# 표시가 없는 옛 형태(감싸지 않은 include 한 줄)도 함께 지운다 — 그 형태로
# 설치했다가 nginx -t 에서 걸린 적이 있고, 롤백이 그 줄을 남겼기 때문이다.
remove_include_block() {
    nginx_conf_has_block || grep -qF "$STREAM_DIR" "$NGINX_CONF" 2>/dev/null || return 0
    backup "$NGINX_CONF"
    sed -i -e "\|^${MARK_BEGIN}\$|,\|^${MARK_END}\$|d" \
           -e "\|^# SIP over TLS — services/kamailio/setup-tls.sh 가 넣었습니다.\$|d" \
           -e "\|^include ${STREAM_DIR}/\*\.conf;\$|d" \
           "$NGINX_CONF"

    # 끝의 빈 줄을 하나로 정리한다. 블록을 넣을 때 앞에 빈 줄을 하나 붙이므로,
    # 켜고 끄기를 반복하면 그것만 쌓인다. $(cat) 이 끝의 개행을 다 버리고
    # printf 가 하나만 되돌린다. 리다이렉트로 써서 소유권과 권한을 유지한다.
    local tmp; tmp="$(mktemp)"
    printf '%s\n' "$(cat "$NGINX_CONF")" > "$tmp"
    cat "$tmp" > "$NGINX_CONF"
    rm -f "$tmp"

    info "  제거: ${NGINX_CONF} 의 stream 블록"
}

# ---------- 점검 ----------

report() {
    local problems=0

    info "Kamailio (평문 TCP 백엔드)"
    if systemctl is-active --quiet kamailio; then
        ok "구동 중"
    else
        warn "구동 중이 아닙니다"; problems=$((problems+1))
    fi
    if ss -lnt 2>/dev/null | grep -q "${BACKEND}\b"; then
        ok "${BACKEND} 듣는 중 — 여기로 넘깁니다"
    else
        warn "${BACKEND} 이 열려 있지 않습니다 (kamailio-local.cfg 의 listen=tcp:127.0.0.1:5060)"
        problems=$((problems+1))
    fi

    echo
    info "nginx"
    systemctl is-active --quiet nginx && ok "구동 중" \
        || { warn "구동 중이 아닙니다"; problems=$((problems+1)); }
    has_stream_module && ok "stream 모듈 있음" \
        || { warn "stream 모듈이 없습니다 — sudo apt install libnginx-mod-stream"; problems=$((problems+1)); }
    grep -qF "$STREAM_DIR" "$NGINX_CONF" 2>/dev/null \
        && ok "nginx.conf 에 streams-enabled include 있음" \
        || no "nginx.conf 에 include 가 없습니다 — sudo $0 --enable 이 넣습니다"
    [[ -f "$STREAM_CONF" ]] && ok "stream 설정 설치됨: $STREAM_CONF" \
        || no "stream 설정 없음 — sudo $0 --enable 로 설치합니다"

    echo
    info "인증서 (nginx 의 http 쪽과 공용)"
    local days
    if [[ -f "$SRC_CERT" ]]; then
        ok "$SRC_CERT"
        info "         CN/SAN: $(openssl x509 -in "$SRC_CERT" -noout -ext subjectAltName 2>/dev/null | tail -1 | sed 's/^ *//')"
        days="$(cert_days_left "$SRC_CERT")"
        if [[ -n "$days" ]]; then
            if   (( days < 0 ));  then warn "만료됨 (${days}일)"; problems=$((problems+1))
            elif (( days < 30 )); then warn "곧 만료 (${days}일 남음)"
            else ok "유효기간 ${days}일 남음"; fi
        fi
    else
        warn "$SRC_CERT 가 없습니다"; problems=$((problems+1))
    fi
    info "         사본을 만들지 않습니다 — nginx master 가 root 라 원본을 그대로 읽습니다"

    echo
    info "주소"
    case "$(local_cfg_state)" in
        readable)
            local addr; addr="$(listen_addr || true)"
            [[ -n "$addr" ]] && ok "TLS 입구: ${addr}:${TLS_PORT} → ${BACKEND}" \
                || { warn "kamailio-local.cfg 의 listen= 에서 주소를 찾지 못했습니다"; problems=$((problems+1)); }
            ;;
        unreadable) no "kamailio-local.cfg 를 읽지 못했습니다 (0640 root:kamailio) — sudo $0 로 보입니다" ;;
        missing)    warn "인증 설정이 없습니다 — sudo ./install.sh --apply 를 먼저 하세요"; problems=$((problems+1)) ;;
    esac

    echo
    info "소켓"
    if ss -lnt 2>/dev/null | grep -q ":${TLS_PORT}\b"; then
        ok "${TLS_PORT} 열려 있음"
        if verify_tls; then verify_sip || problems=$((problems+1)); else problems=$((problems+1)); fi
    else
        no "${TLS_PORT} 이 열려 있지 않습니다"
    fi

    if stale_present; then
        echo
        info "정리 대상"
        no "Kamailio tls 모듈 시도의 잔재가 남아 있습니다: ${STALE_KAMAILIO_TLS[*]}"
        no "  개인키 사본이 포함됩니다. sudo $0 --enable 이 지웁니다"
    fi

    echo
    (( problems == 0 )) && info "남은 문제 없음." || info "확인이 필요한 항목 ${problems}개."
    echo
    echo "공유기에 외부 TCP 포트 하나를 $(probe_addr):${TLS_PORT} 로"
    echo "포워딩해야 외부 단말이 붙습니다. 이 스크립트는 공유기를 건드리지 않습니다."
}

# ---------- 설치 ----------

backup() {
    local file="$1"
    [[ -e "$file" ]] || return 0
    local dest="${file}.bak.$(date +%Y%m%d-%H%M%S)"
    # 한 번 실행에서 같은 파일을 두 번 백업하면 초 단위 타임스탬프가 겹쳐
    # 먼저 뜬 백업을 덮어쓴다. 실제로 --enable 이 nginx.conf 를 지우고 다시
    # 넣으면서 그렇게 됐고, 원래 상태의 백업이 사라졌다.
    local n=1
    while [[ -e "$dest" ]]; do
        dest="${file}.bak.$(date +%Y%m%d-%H%M%S)-${n}"
        n=$((n+1))
    done
    cp -p "$file" "$dest"
    info "  백업: ${dest}"
}

enable_tls() {
    require_root

    [[ -f "$STREAM_TEMPLATE" ]] || die "템플릿이 없습니다: ${STREAM_TEMPLATE}"
    has_stream_module || die "nginx 에 stream 모듈이 없습니다.
  sudo apt install libnginx-mod-stream"
    [[ -r "$SRC_CERT" ]] || die "인증서를 읽을 수 없습니다: ${SRC_CERT}"
    [[ -r "$SRC_KEY"  ]] || die "개인키를 읽을 수 없습니다: ${SRC_KEY}"

    local addr; addr="$(listen_addr || true)"
    [[ -n "$addr" ]] || die "${LOCAL_CFG} 의 listen= 에서 LAN 주소를 찾지 못했습니다."

    ss -lnt 2>/dev/null | grep -q "${BACKEND}\b" \
        || warn "${BACKEND} 이 아직 열려 있지 않습니다 — 넘길 곳이 없으면 연결이 바로 끊깁니다."

    # 인증서와 키가 짝이 맞는가. 어긋나면 reload 후 핸드셰이크에서만 드러난다.
    local cmod kmod
    cmod="$(openssl x509 -in "$SRC_CERT" -noout -modulus 2>/dev/null | openssl md5)"
    kmod="$(openssl rsa  -in "$SRC_KEY"  -noout -modulus 2>/dev/null | openssl md5)"
    [[ "$cmod" == "$kmod" ]] || die "인증서와 개인키가 짝이 맞지 않습니다."

    local staged; staged="$(mktemp)"
    sed -e "s|__SIP_LISTEN_ADDR__|${addr}|" \
        -e "s|__CERT_FILE__|${SRC_CERT}|" \
        -e "s|__KEY_FILE__|${SRC_KEY}|" \
        "$STREAM_TEMPLATE" > "$staged"

    if grep -q '__[A-Z_]*__' "$staged"; then
        local left; left="$(grep -o '__[A-Z_]*__' "$staged" | sort -u | tr '\n' ' ')"
        rm -f "$staged"
        die "템플릿에 치환되지 않은 자리가 남았습니다: ${left}"
    fi

    echo
    echo "다음을 설치합니다:"
    echo "  ${STREAM_CONF}"
    echo "  ${NGINX_CONF} 에 include 한 줄 (없을 때만)"
    echo
    echo "적용하면 바뀌는 것:"
    echo "  - ${addr}:${TLS_PORT} 에서 TLS 를 받아 ${BACKEND} 로 넘깁니다"
    echo "  - **Kamailio 설정은 건드리지 않습니다.** 기존 5060·5080 그대로입니다"
    echo "  - nginx 를 reload 합니다 (기존 HTTP/WSS 연결은 유지됩니다)"
    stale_present && echo "  - 실패한 Kamailio tls 시도의 잔재를 지웁니다 (개인키 사본 포함)"
    echo
    confirm "진행할까요?" || { rm -f "$staged"; echo "취소했습니다."; exit 0; }

    install -d -o root -g root -m 755 "$STREAM_DIR"
    backup "$STREAM_CONF"
    install -o root -g root -m 644 "$staged" "$STREAM_CONF"
    rm -f "$staged"
    info "  설치: ${STREAM_CONF}"

    # nginx.conf 최상위에 stream 블록을 넣는다.
    #
    # ⚠️ stream 은 http 블록 안에 둘 수 없다. 이 프로젝트가 만드는
    #    /etc/nginx/conf.d/path-routing.conf 는 http 안에서 include 되므로
    #    그쪽에 담을 수 없고, 그래서 배포판 nginx.conf 를 고친다.
    #    실패하거나 --disable 하면 걷어낸다.
    local added_block=false
    if nginx_conf_has_block; then
        info "  stream 블록은 이미 있습니다"
    else
        # 옛 형태(감싸지 않은 include)가 남아 있으면 먼저 치운다.
        grep -qF "$STREAM_DIR" "$NGINX_CONF" 2>/dev/null && remove_include_block
        add_include_block
        added_block=true
    fi

    echo
    info "nginx 설정 검사"
    if nginx -t 2>&1 | sed 's/^/    /'; then
        ok "nginx -t 통과"
    else
        warn "검사에 실패했습니다. 설치한 것을 걷어냅니다."
        rm -f "$STREAM_CONF"
        # 이번 실행에서 넣은 것만 되돌린다. 원래 있던 것은 남의 상태다.
        $added_block && remove_include_block
        die "되돌렸습니다. nginx 는 그대로 돌고 있습니다. 위 로그를 확인하세요."
    fi

    systemctl reload nginx
    sleep 2

    if ss -lnt 2>/dev/null | grep -q ":${TLS_PORT}\b"; then
        ok "${addr}:${TLS_PORT} 열림"
        if verify_tls; then
            verify_sip || warn "TLS 는 붙지만 SIP 가 통과하지 않습니다."
        else
            warn "포트는 열렸지만 TLS 핸드셰이크가 되지 않습니다."
        fi
    else
        warn "${TLS_PORT} 이 열리지 않았습니다. journalctl -u nginx -n 30 을 확인하세요."
    fi

    # Kamailio tls 모듈 시도의 잔재 정리 — 개인키 사본이 포함되므로 남기지 않는다.
    local p
    for p in "${STALE_KAMAILIO_TLS[@]}"; do
        [[ -e "$p" ]] || continue
        rm -rf "$p"
        info "  정리: ${p}"
    done

    echo
    echo "확인:"
    echo "  ss -lnpt | grep ${TLS_PORT}"
    echo "  openssl s_client -connect ${addr}:${TLS_PORT} -CAfile ${SRC_CA}"
    echo
    echo "다음 단계:"
    echo "  1. 공유기에 외부 TCP 포트 하나를 ${addr}:${TLS_PORT} 로 포워딩"
    echo "  2. 앱 설정 — 서버 주소는 인증서의 이름과 같아야 합니다"
    echo "     (앱의 libpjsua2.so 가 OpenSSL 없이 빌드돼 있으면 아직 붙지 못합니다)"
    echo "  3. 등록만 보지 말고 **통화까지** 확인하세요 — Kamailio 는 이 연결을"
    echo "     TCP 로 보므로 Record-Route 의 transport 가 tcp 로 나갑니다."
}

disable_tls() {
    require_root

    [[ -f "$STREAM_CONF" ]] || { info "설치되어 있지 않습니다: ${STREAM_CONF}"; exit 0; }

    echo "제거하면 ${TLS_PORT} 수신이 꺼집니다."
    echo "nginx 의 HTTP/WSS 와 Kamailio 의 5060·5080 은 영향받지 않습니다."
    confirm "계속할까요?" || { echo "취소했습니다."; exit 0; }

    backup "$STREAM_CONF"
    rm -f "$STREAM_CONF"
    info "  제거: ${STREAM_CONF}"

    # 디렉토리가 비면 stream 블록도 걷어낸다. 빈 디렉토리를 include 하는 것은
    # 오류가 아니지만, 남겨 두면 왜 있는지 알 수 없는 블록이 된다.
    if [[ -z "$(ls -A "$STREAM_DIR" 2>/dev/null)" ]]; then
        remove_include_block
    fi

    if nginx -t >/dev/null 2>&1; then
        systemctl reload nginx
        ok "nginx reload 완료"
    else
        warn "nginx -t 실패 — reload 하지 않았습니다."
        nginx -t 2>&1 | sed 's/^/    /'
    fi
}

case "$MODE" in
    check)   report ;;
    enable)  enable_tls ;;
    disable) disable_tls ;;
esac
