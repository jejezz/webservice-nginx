#!/usr/bin/env bash
#
# Janus WebRTC ↔ SIP 게이트웨이의 설정을 설치한다.
#
#   ./install.sh                 현재 상태만 점검한다 (아무것도 바꾸지 않음)
#   sudo ./install.sh --apply    설정과 systemd 유닛을 설치하고 janus 를 기동한다
#   sudo ./install.sh --apply -y 확인 없이 진행
#   sudo ./install.sh --remove   설치한 것을 걷어낸다
#
# Janus 는 배포판 패키지가 아니라 /opt/janus 소스 빌드다. .jcfg(libconfig)에는
# include 가 없어 오버라이드를 둘 수 없으므로, 이 저장소가 설정 파일 넷을
# 통째로 소유한다 (docs/plan.md 의 ② 절). 배포본 원본은 옆의 *.jcfg.sample 로
# 그대로 남는다.
#
# Kamailio 는 이 스크립트가 건드리지 않는다. SIP 계정과 레지스트라는
# services/kamailio/ 가 소유하며, 여기서는 연동 대상으로 상태만 확인한다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# apt 에도 janus(0.11.8) 패키지가 있지만 쓰지 않는다. 설정 폴더와 모듈 경로가
# 갈려 어느 쪽이 도는지 헷갈리게 된다 (Kamailio 의 두 벌 설치와 같은 문제).
JANUS_PREFIX="/opt/janus"
JANUS_BIN="${JANUS_PREFIX}/bin/janus"
JANUS_ETC="${JANUS_PREFIX}/etc/janus"
JANUS_JS="${JANUS_PREFIX}/share/janus/javascript/janus.js"

# 이 저장소가 소유할 설정 파일들 (계획서 ② 절).
OWNED_CFGS=(
    janus.jcfg
    janus.transport.http.jcfg
    janus.transport.websockets.jcfg
    janus.plugin.sip.jcfg
)

# 우리가 설치한 파일임을 알아보는 표식. 각 템플릿 머리에 들어 있다.
CFG_MARKER="OWNED-BY-WEBSERVICES"

SECRETS_DIR="${SCRIPT_DIR}/secrets"
ADMIN_SECRET_FILE="${SECRETS_DIR}/admin-secret"
API_SECRET_FILE="${SECRETS_DIR}/api-secret"

# ═══ 배포 설정 ═══════════════════════════════════════════════════════
#
# 장비마다 다르고 회선 따라 바뀌는 값들은 settings.ini 에 있습니다.
# 대시보드의 '설정' 화면이 그 파일을 쓰고, 이 스크립트가 읽습니다.
# 손으로 고쳐도 됩니다 — 어느 쪽이든 반영은 `sudo ./install.sh --apply` 입니다.
#
#   public_ip        공인 IP. 외부(인터넷) 브라우저를 받을 때만 씁니다.
#                    비우면 nat_1_1_mapping 없이 LAN 전용으로 설치됩니다.
#   rtp_port_range   브라우저 ↔ Janus 의 WebRTC 미디어 포트. 공유기에서 이
#                    범위를 UDP 로 포워딩해야 외부 통화의 소리가 납니다.
#   sip_rtp_port_range  Janus ↔ Kamailio(SIP) 의 미디어 포트. LAN 안에서만
#                    오가므로 포워딩 대상이 아닙니다.
#
# 파일이 없으면 기본값(LAN 전용 · 20000-20200)으로 설치됩니다.
# 값이 형식에 맞지 않으면 --apply 가 아무것도 바꾸지 않고 멈춥니다.
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"
# 파일에 그 키가 없을 때 쓰는 값. 설치할 때와 점검할 때가 반드시 같아야 한다 —
# 갈리면 "설치본과 저장한 값이 다르다" 는 거짓 경보가 난다.
DEFAULT_PUBLIC_IP=""
DEFAULT_RTP_RANGE="20000-20200"
DEFAULT_SIP_RTP_RANGE="30000-30200"
# settings.ini 뼈대를 만드는 공용 도구 (settings-schema.json 을 읽는다).
SETTINGS_INIT_CMD="node ../../lib/settings.js --init ."
# 마지막으로 설치한 값. 대시보드가 '적용 대기'를 이걸로 가른다.
APPLIED_FILE="${SCRIPT_DIR}/.applied-settings"

# settings.ini 에서 `키 = 값` 하나를 읽는다. 없으면 기본값.
# 절(section)은 쓰지 않는다 — node 쪽에서도 같은 파일을 파싱한다.
settings_get() {
    local key="$1" fallback="${2:-}" v=""
    if [[ -r "$SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\\(.*\\)$/\\1/p" "$SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
    fi
    v="${v//[[:space:]]/}"
    echo "${v:-$fallback}"
}

# 통화에 쓸 수 있는 인터페이스만 고른다. 가상 브리지·컨테이너·터널은 뺀다 —
# ICE 후보로 실어 보내면 상대가 닿지 않는 곳에 붙으려다 기다린다 (janus.jcfg).
lan_candidates() {
    local ifc cidr
    while read -r ifc cidr; do
        case "$ifc" in
            lo|docker*|virbr*|veth*|br-*|tun*|tap*|wg*|vmnet*|zt*) continue ;;
        esac
        echo "${ifc} ${cidr%%/*}"
    done < <(ip -4 -o addr show scope global 2>/dev/null | awk '{print $2, $4}')
}

# 기본 경로가 나가는 인터페이스. 여럿일 때 무엇을 권할지 정하는 기준이다.
default_route_iface() { ip -4 route show default 2>/dev/null | awk '{print $5; exit}'; }

# SIP_LOCAL_IP · LAN_IFACE 를 정한다.
#   $1 = "ask" 면 후보가 여럿일 때 물어본다. 그 밖에는 절대 묻지 않는다
#        (점검은 아무것도 바꾸지 않고 --yes 는 사람이 없는 자리다).
resolve_lan() {
    local may_ask="${1:-}" cands n pick def_ifc line
    SIP_LOCAL_IP="$(settings_get sip_local_ip "")"
    LAN_IFACE="$(settings_get lan_iface "")"

    cands="$(lan_candidates)"
    n="$(printf '%s\n' "$cands" | grep -c . || true)"

    # settings.ini 에 박혀 있으면 그대로 쓴다. 다만 이 장비에 실재하는지는 본다 —
    # 없는 주소로 설치하면 Janus 는 뜨고 소리만 안 난다.
    if [[ -n "$SIP_LOCAL_IP" && -n "$LAN_IFACE" ]]; then
        printf '%s\n' "$cands" | grep -qx "${LAN_IFACE} ${SIP_LOCAL_IP}" && return 0
        warn "settings.ini 의 sip_local_ip/lan_iface 가 이 장비에 없습니다: ${LAN_IFACE} ${SIP_LOCAL_IP}"
        SIP_LOCAL_IP=""; LAN_IFACE=""
    fi

    (( n > 0 )) || return 1

    def_ifc="$(default_route_iface)"
    # 하나뿐이면 물어볼 것이 없다.
    if (( n == 1 )); then
        read -r LAN_IFACE SIP_LOCAL_IP <<<"$cands"
        return 0
    fi

    # 여럿이다. 기본 경로가 나가는 것을 권한다.
    pick="$(printf '%s\n' "$cands" | awk -v d="$def_ifc" '$1==d{print; exit}')"
    [[ -n "$pick" ]] || pick="$(printf '%s\n' "$cands" | head -1)"

    if [[ "$may_ask" == "ask" && -t 0 ]]; then
        echo
        echo "통화에 쓸 인터페이스를 고르세요 (SIP SDP 주소 · ICE 후보):"
        local i=0 sel
        while read -r line; do
            i=$((i + 1))
            [[ "$line" == "$pick" ]] \
                && echo "  ${i}) ${line}   ← 기본 경로. 권장" \
                || echo "  ${i}) ${line}"
        done <<<"$cands"
        read -r -p "번호 [기본: 권장] " sel || sel=""
        if [[ "$sel" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= n )); then
            pick="$(printf '%s\n' "$cands" | sed -n "${sel}p")"
        fi
    fi
    read -r LAN_IFACE SIP_LOCAL_IP <<<"$pick"
    return 0
}

# 고른 값을 settings.ini 에 남긴다. 다음 실행부터 묻지 않고, 대시보드도 읽는다.
settings_put() {
    local key="$1" val="$2"
    if [[ -f "$SETTINGS_FILE" ]] && grep -q "^[[:space:]]*${key}[[:space:]]*=" "$SETTINGS_FILE"; then
        sed -i "s|^[[:space:]]*${key}[[:space:]]*=.*|${key} = ${val}|" "$SETTINGS_FILE"
    else
        [[ -f "$SETTINGS_FILE" ]] || echo "; install.sh 가 만들었습니다. 항목의 뜻은 settings-schema.json 에 있습니다." > "$SETTINGS_FILE"
        echo "${key} = ${val}" >> "$SETTINGS_FILE"
    fi
    chown "$SUDO_UID:$SUDO_GID" "$SETTINGS_FILE" 2>/dev/null || true
}
# ═════════════════════════════════════════════════════════════════════

SERVICE_TEMPLATE="${SCRIPT_DIR}/janus.service"
SERVICE_UNIT="/etc/systemd/system/janus.service"
# 기동 직전에 공인 IP 를 설치본에 맞추는 유닛. janus.service 가 Wants 로 부른다.
PUBIP_TEMPLATE="${SCRIPT_DIR}/janus-public-ip.service"
PUBIP_UNIT="/etc/systemd/system/janus-public-ip.service"
JANUS_USER="janus"

# 계획서 ①③⑦ 에서 정한 값들. 설정 파일과 여기가 어긋나면 점검이 잡아낸다.
API_BASE_PATH="/janus-api"
API_PORT=8088
ADMIN_PORT=7088
WS_PORT=8188
DASHBOARD_PORT=28087
# SIP 쪽 SDP 에 실릴 주소와 ICE 후보를 모을 인터페이스.
#
# 예전에는 이 둘을 여기에 박아 두었다(192.168.0.252 · enp2s0). 처음 세운 장비의
# 값이라 다른 장비에서는 틀렸고, 틀린 채로도 Janus 는 떠서 **시그널링은 되고
# 소리만 안 나는** 모양이 됐다 (계획서 ③).
#
# 그래서 감지한다. 통화에 못 쓰는 인터페이스(도커·libvirt·터널)는 빼고,
# 남은 것이 여럿이면 사람에게 고르게 한다. 고른 값은 settings.ini 에 적어 다음
# 실행부터는 묻지 않는다.
SIP_LOCAL_IP=""
LAN_IFACE=""

# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
# ok · warn · info 는 예전과 같고, 예전의 no() 는 skip/pend 로 나뉜다.
source "${SCRIPT_DIR}/../../lib/check-report.sh"
# 설치본이 저장소와 같은지 보는 공용 비교.
source "${SCRIPT_DIR}/../../lib/config-diff.sh"
die()  { echo "오류: $*" >&2; exit 1; }

# --json 은 아래 인자 파싱보다 **먼저** 걸러낸다. 그러지 않으면 "Unknown option"
# 으로 걸린다.
check_init "janus.config"       # docs/check-contract.md 의 step id
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

# curl 은 연결 실패에도 %{http_code} 로 "000" 을 찍고 종료 코드만 0 이 아니다.
# `|| echo 000` 를 붙이면 "000000" 이 되어 버린다. 종료 코드는 무시하고
# 출력만 쓴다.
probe_http() {
    local out
    out="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)" || true
    echo "${out:-000}"
}

confirm() {
    $ASSUME_YES && return 0
    read -r -p "$1 [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

require_root() {
    [[ "$(id -u)" -eq 0 ]] || die "이 동작은 root 권한이 필요합니다. sudo 로 다시 실행하세요."
}

# ini 선언에서 enabled 값을 읽는다. 없으면 규약상 기본은 true.
ini_enabled() {
    local file="$1" value
    [[ -f "$file" ]] || { echo "missing"; return 0; }
    value="$(sed -n 's/^[[:space:]]*enabled[[:space:]]*=[[:space:]]*\([a-zA-Z]*\).*/\1/p' "$file" | tail -1)"
    echo "${value:-true}"
}

# .jcfg 에서 rtp_port_range 값을 "최소 최대" 로 뽑는다. 없으면 빈 문자열.
#
# 설정 파일을 진실로 삼는다 — 이 스크립트에 숫자를 또 적어 두면 둘이 어긋난다.
jcfg_rtp_range() {
    local file="$1"
    # janus.jcfg 의 미디어 범위는 설치할 때 RTP_PORT_RANGE 로 덮어써진다.
    # 그러니 겹침 검사도 **설치될 값**을 봐야 한다 — 템플릿에 남아 있는 옛 값을
    # 보면, 실제로는 겹치는데 검사가 통과하는 일이 생긴다.
    if [[ "$file" == "${SCRIPT_DIR}/janus.jcfg" ]]; then
        local configured; configured="$(settings_get rtp_port_range "")"
        if [[ "$configured" =~ ^([0-9]+)-([0-9]+)$ ]]; then
            echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
            return 0
        fi
    fi
    if [[ "$file" == "${SCRIPT_DIR}/janus.plugin.sip.jcfg" ]]; then
        local configured; configured="$(settings_get sip_rtp_port_range "")"
        if [[ "$configured" =~ ^([0-9]+)-([0-9]+)$ ]]; then
            echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
            return 0
        fi
    fi
    [[ -r "$file" ]] || return 0
    sed -n 's/^[[:space:]]*rtp_port_range[[:space:]]*=[[:space:]]*"\([0-9]\{1,\}\)-\([0-9]\{1,\}\)".*/\1 \2/p' "$file" | head -1
}

# ── 미디어 릴레이는 배포판마다 다르다 ──────────────────────────────────
#
# Kamailio 가 NAT 로 판정한 통화의 미디어를 중계하는 데몬이다. 이 배치에서는
# LAN 단말 전부가 NAT 로 판정되므로 사실상 모든 통화가 여기를 지난다
# (docs/plan.md ③ 정정).
#
#   Ubuntu 22.04   rtpproxy      (24.04 저장소에서 빠졌다)
#   Ubuntu 24.04   rtpengine     (kamailio.cfg 의 WITH_RTPENGINE 분기)
#
# 그래서 이름 하나를 못 박지 않고 **있는 쪽**을 본다. 둘 다 없으면 이 OS 에서
# 무엇을 넣어야 하는지 알려 준다.
media_relay_kind() {
    if pgrep -x rtpengine >/dev/null 2>&1 || [[ -f /etc/rtpengine/rtpengine.conf ]]; then
        echo rtpengine; return 0
    fi
    if pgrep -x rtpproxy >/dev/null 2>&1 || [[ -f /etc/default/rtpproxy ]]; then
        echo rtpproxy; return 0
    fi
    echo ""
}

# 데몬 유닛 이름은 패키지마다 다르다 (rtpengine-daemon · rtpengine).
relay_unit_state() {
    local kind="$1" u
    case "$kind" in
        rtpengine) for u in rtpengine-daemon rtpengine ngcp-rtpengine-daemon; do
                       systemctl list-unit-files "${u}.service" &>/dev/null || continue
                       systemctl is-active "$u" 2>/dev/null && return 0
                   done ;;
        rtpproxy)  systemctl is-active rtpproxy 2>/dev/null && return 0 ;;
    esac
    echo inactive
}

# rtpengine 의 포트 범위. /etc/rtpengine/rtpengine.conf 의 port-min · port-max.
rtpengine_range() {
    local f="/etc/rtpengine/rtpengine.conf" mn mx
    [[ -r "$f" ]] || return 0
    mn="$(sed -n 's/^[[:space:]]*port-min[[:space:]]*=[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$f" | tail -1)"
    mx="$(sed -n 's/^[[:space:]]*port-max[[:space:]]*=[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$f" | tail -1)"
    [[ -n "$mn" && -n "$mx" ]] && echo "$mn $mx"
}

# rtpproxy 가 쓰는 포트 범위. 배포판 기본값은 35000-65000 이고 -m/-M 이 덮는다.
#
# ⚠️ **-M 을 안 주면 최대가 65000 이다.** /etc/default/rtpproxy 에 -m 만 적혀
#    있으면 그 위쪽 전부가 rtpproxy 것이 되어 Janus 의 범위를 통째로 삼킨다.
#    실제로 그런 상태였다 (docs/plan.md ③ 절의 정정).
rtpproxy_range() {
    local file="/etc/default/rtpproxy" opts mn mx
    [[ -r "$file" ]] || return 0
    opts="$(sed -n 's/^EXTRA_OPTS=//p' "$file" | tr -d '"' || true)"
    # 같은 플래그가 여러 번 적혀 있으면 뒤엣것이 이긴다.
    mn="$(grep -oE -- '-m[[:space:]]*[0-9]+' <<<"$opts" | tail -1 | grep -oE '[0-9]+' || true)"
    mx="$(grep -oE -- '-M[[:space:]]*[0-9]+' <<<"$opts" | tail -1 | grep -oE '[0-9]+' || true)"
    echo "${mn:-35000} ${mx:-65000}"
}

# 두 구간이 겹치는가. [a1,a2] 와 [b1,b2] 는 a1<=b2 이고 b1<=a2 일 때 겹친다.
ranges_overlap() {
    [[ $1 -le $4 && $3 -le $2 ]]
}

# 포트를 듣고 있는 주소. 없으면 빈 문자열.
listen_addr() {
    local port="$1"
    # awk 가 첫 매치에서 exit 하면 ss 가 나머지를 다 쓰기 전에 파이프가 닫혀
    # SIGPIPE(141)를 받는다 — pipefail 아래서는 이게 스크립트 전체를 죽인다.
    # 원하는 값은 이미 얻었으니 그 종료 코드는 버린다.
    ss -lnt 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" { print $4; exit }' || true
}

# 템플릿이 어느 .sample 에서 갈라져 나왔는지. 머리 주석의 derived-from-sample.
declared_sample_hash() {
    sed -n 's/^#[[:space:]]*derived-from-sample:[[:space:]]*\([0-9a-f]\{16\}\).*/\1/p' "$1" | head -1
}

actual_sample_hash() {
    [[ -f "$1" ]] || return 0
    sha256sum "$1" | cut -c1-16
}

# libjanus_videoroom.so → janus.plugin.videoroom
plugin_name_of() {
    local f="${1##*/}"
    f="${f#libjanus_}"
    f="${f%.so}"
    echo "janus.plugin.${f}"
}

# 선언대로 올라왔는가.
#
# janus.jcfg 의 plugins.disable 에 없는 플러그인은 전부 올라와 있어야 한다.
# **설정을 썼다는 것과 그렇게 동작한다는 것은 다르다** — 여기서 어긋나면 대개
# --apply 를 아직 안 돌린 것이다. 설치본 janus.jcfg 는 root 전용이라 내용을
# 볼 수 없지만, 그 결과인 /info 는 누구나 볼 수 있다.
report_loaded_plugins() {
    local info
    info="$(curl -s -m 3 "http://127.0.0.1:${API_PORT}${API_BASE_PATH}/info" 2>/dev/null || true)"
    if [[ -z "$info" ]]; then
        skip "플러그인 목록을 읽지 못해 확인을 건너뜁니다 (${API_BASE_PATH}/info)"
        return 0
    fi

    local disabled
    disabled="$(sed -n 's/^[[:space:]]*disable[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "${SCRIPT_DIR}/janus.jcfg" | head -1)"

    local loaded
    loaded="$(grep -o '"janus\.plugin\.[a-z0-9_]*"' <<<"$info" | tr -d '"' | sort -u)"

    local lib base name missing=0
    for lib in "${JANUS_PREFIX}"/lib/janus/plugins/libjanus_*.so; do
        [[ -e "$lib" ]] || continue
        base="${lib##*/}"
        # 목록에 있으면 일부러 안 올린 것이다.
        [[ ",${disabled}," == *",${base},"* ]] && continue

        name="$(plugin_name_of "$base")"
        if grep -qx "$name" <<<"$loaded"; then
            ok "${name#janus.plugin.} 올라옴"
        else
            pend "${name#janus.plugin.} 이 선언에는 켜져 있는데 올라오지 않았습니다 → sudo $0 --apply"
            missing=$((missing + 1))
        fi
    done

    # 반대쪽 — 끄기로 한 것이 올라와 있으면 설치본이 저장소와 다른 것이다.
    local up
    while read -r up; do
        [[ -z "$up" ]] && continue
        base="libjanus_${up#janus.plugin.}.so"
        if [[ ",${disabled}," == *",${base},"* ]]; then
            pend "${up#janus.plugin.} 은 끄기로 했는데 올라와 있습니다 → sudo $0 --apply"
            missing=$((missing + 1))
        fi
    done <<<"$loaded"

    return $missing
}

# ---------- 점검 ----------

report() {
    local problems=0 pending=0

    info "Janus 설치"
    if [[ -x "$JANUS_BIN" ]]; then
        local ver
        ver="$("$JANUS_BIN" --version 2>/dev/null | sed -n 's/^Janus version: //p')"
        ok "바이너리: ${JANUS_BIN} (${ver:-버전 확인 불가})"
    else
        warn "Janus 가 없습니다: ${JANUS_BIN}"
        warn "  소스: ~/Public/RetroLink/janus-gateway — ./configure --prefix=${JANUS_PREFIX} 로 빌드"
        problems=$((problems + 1))
    fi

    # WebSocket 트랜스포트가 여기 끼어 있는 이유 — 이것이 빠져도 configure 는
    # 실패하지 않는다. libwebsockets-dev 가 없으면 요약에 "WebSockets transport:
    # no" 라고만 적고 그냥 넘어간다. 그러면 설치는 다 끝난 것처럼 보이다가
    # 기동 뒤 8188 이 안 열리는 것으로만 드러난다. 빌드에서 잡는 편이 낫다.
    local missing_mod=0 mod
    for mod in "lib/janus/plugins/libjanus_sip.so" \
               "lib/janus/transports/libjanus_http.so" \
               "lib/janus/transports/libjanus_websockets.so"; do
        [[ -e "${JANUS_PREFIX}/${mod}" ]] || { warn "모듈 없음: ${JANUS_PREFIX}/${mod}"; missing_mod=1; }
    done
    if [[ $missing_mod -eq 0 ]]; then
        ok "필요한 모듈 있음 (SIP 플러그인 · HTTP · WebSocket 트랜스포트)"
    else
        warn "  빌드에 빠진 것입니다 — sudo ./bootstrap.sh --install 뒤 소스에서 다시 빌드하세요"
        problems=$((problems + 1))
    fi

    if [[ -f "$JANUS_JS" ]]; then
        ok "janus.js: ${JANUS_JS}"
    else
        warn "janus.js 를 찾지 못했습니다: ${JANUS_JS}"
        problems=$((problems + 1))
    fi

    if id "$JANUS_USER" &>/dev/null; then
        ok "실행 계정: ${JANUS_USER} (uid $(id -u "$JANUS_USER"))"
    else
        pend "실행 계정 ${JANUS_USER} 없음 — --apply 가 만듭니다"
        pending=$((pending + 1))
    fi

    info ""
    info "설정 (${JANUS_ETC})"
    local cfg
    for cfg in "${OWNED_CFGS[@]}"; do
        local target="${JANUS_ETC}/${cfg}" sample="${JANUS_ETC}/${cfg}.sample" tmpl="${SCRIPT_DIR}/${cfg}"

        if [[ ! -f "$tmpl" ]]; then
            warn "${cfg} — 설치할 원본이 이 디렉토리에 없습니다"
            problems=$((problems + 1))
            continue
        fi

        if [[ ! -f "$target" ]]; then
            pend "${cfg} — 설치되지 않음"
            pending=$((pending + 1))
        elif [[ ! -r "$target" ]]; then
            # janus.jcfg 는 비밀을 담아 0640 root:janus 로 설치한다. 일반 사용자는
            # 읽을 수 없다. **읽지 못한 것을 "고친 흔적" 으로 보고하면 안 된다** —
            # 실제로 그렇게 보고해 멀쩡한 설치를 문제로 잡은 적이 있다.
            # (services/kamailio/install.sh 도 같은 이유로 같은 분기를 둔다)
            ok "${cfg} — 설치됨 (내용 확인 불가, root 전용. sudo $0 로 보세요)"
        elif grep -q "$CFG_MARKER" "$target" 2>/dev/null; then
            # 설치할 때 값이 들어가거나(비밀·포트 범위) 아예 지워지는(공인 IP)
            # 자리는 비교에서 뺀다. 나머지가 다르면 저장소 쪽이 앞서 간 것이다.
            #
            # 예전에는 비밀 두 줄만 눌러 비교했다. 그러면 공인 IP 를 쓴 설치에서
            # nat_1_1_mapping 한 줄 때문에 늘 "다르다" 가 나왔다 — 그 파일은
            # root 전용이라 일반 사용자에게는 드러나지 않았을 뿐이다.
            report_config_diff "${cfg}" "sudo $0 --apply" \
                -n 's%^\([[:space:]]*admin_secret = \).*%\1«%' \
                -n 's%^\([[:space:]]*api_secret = \).*%\1«%' \
                -n 's%^\([[:space:]]*rtp_port_range = \).*%\1«%' \
                -n 's%^\([[:space:]]*local_ip = \).*%\1«%' \
                -n 's%^\([[:space:]]*ice_enforce_list = \).*%\1«%' \
                -x 'nat_1_1_mapping' \
                -x 'keep_private_host' \
                "$target" "$tmpl" \
                || problems=$((problems + 1))
        elif [[ -f "$sample" ]] && cmp -s "$target" "$sample"; then
            pend "${cfg} — 배포본 그대로 (아직 결정이 반영되지 않음)"
            pending=$((pending + 1))
        else
            warn "${cfg} — 손으로 고친 흔적이 있습니다 (sample 과 다르고 표식도 없음)"
            problems=$((problems + 1))
        fi

        # 업스트림이 바뀌었는지. Janus 를 올리면 .sample 이 새로 깔린다.
        local declared actual
        declared="$(declared_sample_hash "$tmpl")"
        actual="$(actual_sample_hash "$sample")"
        if [[ -n "$declared" && -n "$actual" && "$declared" != "$actual" ]]; then
            warn "  ${cfg}.sample 이 바뀌었습니다 (${declared} → ${actual}) — 업스트림 변경을 확인하세요"
        fi
    done

    # 치환이 안 된 채 설치되면 Janus 는 그 문자열을 진짜 비밀번호로 쓴다.
    if [[ -r "${JANUS_ETC}/janus.jcfg" ]] && grep -q '__ADMIN_SECRET__\|__API_SECRET__\|__PUBLIC_IP__' "${JANUS_ETC}/janus.jcfg"; then
        warn "janus.jcfg 에 치환되지 않은 자리표시자가 남아 있습니다"
        problems=$((problems + 1))
    fi

    info ""
    info "비밀 (${SECRETS_DIR})"
    local sf name
    for sf in "$ADMIN_SECRET_FILE:Admin API" "$API_SECRET_FILE:시그널링 API"; do
        name="${sf##*:}"; sf="${sf%%:*}"
        if [[ -f "$sf" ]]; then
            local perm; perm="$(stat -c '%a' "$sf")"
            if [[ "$perm" == "600" ]]; then
                ok "${name}: $(basename "$sf") (권한 600, 소유 $(stat -c '%U' "$sf"))"
            else
                warn "${name}: $(basename "$sf") 의 권한이 ${perm} 입니다 — 600 이어야 합니다"
                problems=$((problems + 1))
            fi
        else
            pend "${name}: $(basename "$sf") 없음 — --apply 가 만듭니다"
            pending=$((pending + 1))
        fi
    done
    # 배포본 기본값(janusoverlord)은 공개돼 있다. Admin API 는 세션 강제 종료까지
    # 되므로, 그 값으로 **실제로 떠 있으면** 문제다 (계획서 ④ 절).
    # 아직 기동 전이라면 문제가 아니라 남은 일이다 — 둘을 구분한다.
    if [[ -r "${JANUS_ETC}/janus.jcfg" ]] && grep -q '^[[:space:]]*admin_secret[[:space:]]*=[[:space:]]*"janusoverlord"' "${JANUS_ETC}/janus.jcfg"; then
        if systemctl is-active --quiet janus 2>/dev/null; then
            warn "admin_secret 이 배포본 기본값(janusoverlord)인 채로 Janus 가 떠 있습니다"
            problems=$((problems + 1))
        else
            pend "janus.jcfg 의 admin_secret 이 배포본 기본값입니다 — --apply 가 바꿉니다"
        fi
    fi

    info ""
    info "systemd"
    if [[ -f "$SERVICE_UNIT" ]]; then
        # 유닛도 저장소가 소유한다. 있는지만 보면 낡은 유닛을 못 잡는다.
        report_config_diff "유닛 ${SERVICE_UNIT##*/}" "sudo $0 --apply" \
            "$SERVICE_UNIT" "$SERVICE_TEMPLATE" || problems=$((problems + 1))
        systemctl is-enabled --quiet janus 2>/dev/null \
            && ok "부팅 시 자동 기동 (enabled)" \
            || { warn "enabled 가 아닙니다 — 재부팅하면 뜨지 않습니다"; problems=$((problems + 1)); }
        systemctl is-active --quiet janus 2>/dev/null \
            && ok "구동 중" \
            || { warn "구동 중이 아닙니다 (journalctl -u janus -n 40)"; problems=$((problems + 1)); }
        # 공인 IP 동기화 유닛. __REPO_DIR__ 은 설치할 때 이 디렉토리로 바뀌므로
        # 비교 전에 원본에도 같은 치환을 걸어 준다.
        if [[ -f "$PUBIP_UNIT" ]]; then
            report_config_diff "유닛 ${PUBIP_UNIT##*/}" "sudo $0 --apply" \
                -n "s%__REPO_DIR__%${SCRIPT_DIR}%g" \
                "$PUBIP_UNIT" "$PUBIP_TEMPLATE" || problems=$((problems + 1))
        else
            pend "유닛 없음: ${PUBIP_UNIT} — 공인 IP 가 바뀌면 기동 뒤 외부 통화가 무음이 됩니다"
            pending=$((pending + 1))
        fi
    else
        pend "유닛 없음: ${SERVICE_UNIT}"
        pending=$((pending + 1))
    fi

    info ""
    info "실행 상태"
    local api_addr admin_addr ws_addr
    api_addr="$(listen_addr "$API_PORT")"
    admin_addr="$(listen_addr "$ADMIN_PORT")"
    ws_addr="$(listen_addr "$WS_PORT")"

    if [[ -n "$api_addr" ]]; then
        ok "시그널링 API 수신 중: ${api_addr}"
        # is-active 나 포트만 믿지 않는다. Kamailio 에서 포트도 열리고
        # is-active 도 정상인데 실제로는 아무 응답이 없던 전례가 있다
        # (services/kamailio/docs/websocket-plan.md ①-1).
        local code
        code="$(probe_http "http://127.0.0.1:${API_PORT}${API_BASE_PATH}/info")"
        if [[ "$code" == "200" ]]; then
            ok "실제 응답 확인: GET ${API_BASE_PATH}/info → 200"
        else
            code="$(probe_http "http://127.0.0.1:${API_PORT}/janus/info")"
            if [[ "$code" == "200" ]]; then
                warn "base_path 가 아직 배포본 기본값(/janus)입니다 — ${API_BASE_PATH} 로 바꿔야 /janus/ 라우트와 겹치지 않습니다"
            else
                warn "포트는 열려 있는데 ${API_BASE_PATH}/info 가 응답하지 않습니다 (HTTP ${code})"
            fi
            problems=$((problems + 1))
        fi
    else
        pend "시그널링 API(${API_PORT}) 가 열려 있지 않습니다"
        pending=$((pending + 1))
    fi

    info ""
    info "선언대로 올라왔는가 (janus.jcfg 의 plugins.disable)"
    report_loaded_plugins || pending=$((pending + $?))

    if [[ -n "$admin_addr" ]]; then
        if [[ "$admin_addr" == 127.0.0.1:* ]]; then
            ok "Admin API 수신 중: ${admin_addr} (루프백 전용)"
        else
            warn "Admin API 가 ${admin_addr} 에 열려 있습니다 — 127.0.0.1 로 좁히세요"
            problems=$((problems + 1))
        fi
    else
        pend "Admin API(${ADMIN_PORT}) 가 열려 있지 않습니다 — 대시보드가 상태를 읽지 못합니다"
        pending=$((pending + 1))
    fi

    # WebRTC 클라이언트가 붙는 시그널링 입구. 밖에서는 nginx 가 TLS 를 끊고
    # /janus-ws 로 넘긴다 (nginx-conf/service.ini 의 [route:ws]).
    if [[ -z "$ws_addr" ]]; then
        pend "WebSocket 트랜스포트(${WS_PORT})가 열려 있지 않습니다 — WebRTC 클라이언트가 붙을 곳이 없습니다"
        [[ -e "${JANUS_PREFIX}/lib/janus/transports/libjanus_websockets.so" ]] \
            || pend "  모듈이 아예 없습니다 — libwebsockets 없이 빌드된 것입니다 (위의 '모듈 없음' 참고)"
        pending=$((pending + 1))
    elif [[ "$ws_addr" == 127.0.0.1:* ]]; then
        ok "WebSocket 수신 중: ${ws_addr} (루프백 전용 — 밖에서는 nginx 의 /janus-ws 로)"
    else
        # 밖에서 직접 닿으면 TLS 없이 시그널링이 오간다. ws_ip 로 좁혀야 한다.
        warn "WebSocket 이 ${ws_addr} 에 열려 있습니다 — ws_ip 를 127.0.0.1 로 좁히세요"
        problems=$((problems + 1))
    fi

    info ""
    info "단말 토큰 (docs/client-migration.md)"
    # api_secret 은 단지에 하나뿐이라 모든 폰에 같은 값이 들어간다. 한 대에서
    # 새면 이 게이트웨이 전체가 열리고 그 한 대만 막을 방법이 없다. 그래서
    # websocket-relay 가 단말마다 다른 토큰을 발급한다.
    #
    # 설치본 janus.jcfg 는 root 전용이라 파일로 확인할 수 없다. Admin API 에
    # 물어보면 확실하다 — token_auth 가 꺼져 있으면 490 으로 답한다.
    local token_state="unknown" admin_secret_value=""
    [[ -r "$ADMIN_SECRET_FILE" ]] && admin_secret_value="$(head -1 "$ADMIN_SECRET_FILE" | tr -d '\r\n')"

    if [[ -n "$admin_secret_value" && -n "$admin_addr" ]]; then
        local body
        body="$(curl -s -m 3 -X POST "http://127.0.0.1:${ADMIN_PORT}/admin" \
                    -H 'Content-Type: application/json' \
                    -d "{\"janus\":\"list_tokens\",\"transaction\":\"chk\",\"admin_secret\":\"${admin_secret_value}\"}" 2>/dev/null || true)"
        case "$body" in
            *'"success"'*) token_state="on" ;;
            *490*)         token_state="off" ;;
        esac
    fi

    case "$token_state" in
        on)  ok "token_auth 켜져 있음 — 단말마다 다른 토큰으로 붙습니다" ;;
        off) pend "token_auth 가 꺼져 있습니다 — 모든 단말이 같은 api_secret 을 씁니다 → sudo $0 --apply"
             pending=$((pending + 1)) ;;
        *)   skip "token_auth 상태를 확인하지 못했습니다 (Admin API 응답 없음)" ;;
    esac

    # 릴레이 쪽 스위치(JANUS_TOKEN_AUTH)는 여기서 보지 않는다. 그 파일은
    # websocket-relay 가 소유하고, 어긋남은 check-relay.sh 가 잡는다.
    #
    # 전환이 끝나면 api_secret 을 지워야 한다 — 남겨 두면 Janus 는 둘 중 하나만
    # 맞아도 통과시키므로 토큰을 발급한 의미가 없어진다.
    #
    # **판정에는 넣지 않는다.** 앱이 token 을 쓰기 시작해야 지울 수 있는데, 그
    # 시점은 이 단계가 정할 수 없다. pending 으로 두면 이 단계가 영원히 미완료가
    # 되고 뒤따르는 단계들이 잠긴다 (nginx.routes · relay.service · verify.call).
    if [[ "$token_state" == "on" ]] \
       && grep -qE '^[[:space:]]*api_secret[[:space:]]*=' "${SCRIPT_DIR}/janus.jcfg"; then
        skip "api_secret 이 아직 남아 있습니다 — 앱이 token 을 쓰기 시작하면 지우세요 (이 단계의 완료 조건은 아닙니다)"
    fi

    # Admin API 는 세션 조회·토큰 발급·핸들 강제 종료가 전부 되는 문이다.
    # nginx 는 nginx-conf/*.ini 에 적힌 포트로만 프록시를 만들 수 있으므로,
    # 거기 admin 포트가 없으면 밖으로 나갈 길이 없다.
    if grep -rqE "^[[:space:]]*(ports|port)[[:space:]]*=[[:space:]]*.*\b${ADMIN_PORT}\b" \
           "${SCRIPT_DIR}/nginx-conf/" 2>/dev/null; then
        warn "nginx 선언에 Admin 포트(${ADMIN_PORT})가 있습니다 — 밖으로 열면 안 됩니다"
        problems=$((problems + 1))
    else
        ok "Admin 포트(${ADMIN_PORT})는 nginx 선언에 없습니다 — 밖으로 나갈 길이 없습니다"
    fi

    info ""
    info "미디어 포트 범위"
    # 겹치면 조용히 실패한다. 통화는 성립하는데 소리만 안 나거나, 어느 한쪽이
    # 포트를 못 잡는 형태로 나타난다.
    local web_range sip_range rtpp_range
    web_range="$(jcfg_rtp_range "${SCRIPT_DIR}/janus.jcfg")"
    sip_range="$(jcfg_rtp_range "${SCRIPT_DIR}/janus.plugin.sip.jcfg")"
    local relay; relay="$(media_relay_kind)"
    case "$relay" in
        rtpengine) rtpp_range="$(rtpengine_range)" ;;
        rtpproxy)  rtpp_range="$(rtpproxy_range)" ;;
        *)         rtpp_range="" ;;
    esac

    [[ -n "$web_range" ]] && ok "Janus WebRTC 쪽: ${web_range% *}-${web_range#* } (janus.jcfg)" \
                          || { warn "janus.jcfg 에서 rtp_port_range 를 읽지 못했습니다"; problems=$((problems + 1)); }
    [[ -n "$sip_range" ]] && ok "Janus SIP 쪽:    ${sip_range% *}-${sip_range#* } (janus.plugin.sip.jcfg)" \
                          || { warn "janus.plugin.sip.jcfg 에서 rtp_port_range 를 읽지 못했습니다"; problems=$((problems + 1)); }

    if [[ -n "$rtpp_range" ]]; then
        local rtpp_state
        rtpp_state="$(relay_unit_state "$relay")"
        info "  ${relay}:$(printf '%*s' $(( 16 - ${#relay} )) '')${rtpp_range% *}-${rtpp_range#* } (${rtpp_state})"
        info "                   Kamailio 가 NAT 로 판정한 통화의 미디어를 중계합니다."
        info "                   이 배치에서는 LAN 단말 전부가 그렇습니다 (docs/plan.md ③ 정정)."

        local r1 r2 j1 j2 label clashes=0
        r1="${rtpp_range% *}"; r2="${rtpp_range#* }"
        for label in "WebRTC:${web_range}" "SIP:${sip_range}"; do
            [[ "${label#*:}" == "" ]] && continue
            j1="${label#*:}"; j2="${j1#* }"; j1="${j1% *}"
            if ranges_overlap "$r1" "$r2" "$j1" "$j2"; then
                warn "${relay}(${r1}-${r2}) 와 Janus ${label%%:*}(${j1}-${j2}) 가 겹칩니다"
                if [[ "$relay" == "rtpengine" ]]; then
                    warn "  /etc/rtpengine/rtpengine.conf 의 port-min · port-max 를 옮기세요."
                else
                    warn "  /etc/default/rtpproxy 의 EXTRA_OPTS 에 -M 을 주어 위쪽을 막으세요."
                    warn "  -M 이 없으면 최대가 65000 이라 Janus 범위를 통째로 삼킵니다."
                fi
                clashes=$((clashes + 1))
                problems=$((problems + 1))
            fi
        done
        [[ $clashes -eq 0 ]] && ok "범위가 서로 겹치지 않습니다"
    elif [[ -n "$relay" ]]; then
        skip "${relay} 의 포트 범위를 읽지 못해 겹침을 검사하지 못했습니다"
    else
        skip "미디어 릴레이가 없습니다 — services/kamailio 가 소유합니다 (아래 '연동 대상')"
    fi

    info ""
    info "통화에 쓸 인터페이스 (SIP SDP 주소 · ICE 후보)"
    # 이 장비에는 통화와 무관한 인터페이스가 여럿이다. 그대로 두면 Janus 가
    # 저 주소까지 후보로 실어 보내고, 상대는 닿지 않는 곳에 붙으려다 기다린다.
    if resolve_lan; then
        if [[ -n "$(settings_get lan_iface '')" ]]; then
            ok "${LAN_IFACE} ${SIP_LOCAL_IP}  ← settings.ini 에 정해 둔 값"
        else
            ok "${LAN_IFACE} ${SIP_LOCAL_IP}  ← 감지한 값 (--apply 가 물어보고 settings.ini 에 적습니다)"
        fi
    else
        warn "쓸 수 있는 인터페이스를 찾지 못했습니다 — 이 장비에 LAN 주소가 있습니까?"
        problems=$((problems + 1))
    fi
    local iface addr
    while read -r iface addr; do
        [[ "$iface" == "lo" ]] && continue
        [[ "$iface" == "$LAN_IFACE" ]] && continue
        skip "${iface} ${addr}  (ICE 후보에서 빠진다)"
    done < <(ip -o -4 addr show 2>/dev/null | awk '{print $2, $4}')

    info ""
    info "연동 대상 — Kamailio (services/kamailio/ 가 소유)"
    if systemctl is-active --quiet kamailio 2>/dev/null; then
        ok "구동 중"
        if ss -lnu 2>/dev/null | grep -q "${SIP_LOCAL_IP}:5060"; then
            ok "SIP 수신 중: ${SIP_LOCAL_IP}:5060/udp — Janus 는 이 주소로 붙는다 (plan.md ③)"
        else
            warn "${SIP_LOCAL_IP}:5060/udp 를 듣고 있지 않습니다 — SDP 주소 결정을 다시 봐야 합니다"
            problems=$((problems + 1))
        fi
    else
        warn "Kamailio 가 구동 중이 아닙니다 (services/kamailio/README.md)"
        problems=$((problems + 1))
    fi

    info ""
    info "이 저장소의 선언"
    local ng_svc ng_dash pm_dash
    ng_svc="$(ini_enabled "${SCRIPT_DIR}/nginx-conf/service.ini")"
    ng_dash="$(ini_enabled "${SCRIPT_DIR}/nginx-conf/dashboard.ini")"
    pm_dash="$(ini_enabled "${SCRIPT_DIR}/pm2-conf/dashboard.ini")"
    info "  nginx-conf/service.ini    enabled = ${ng_svc}   (${API_BASE_PATH}/ → ${API_PORT})"
    info "  nginx-conf/dashboard.ini  enabled = ${ng_dash}   (/janus/ → ${DASHBOARD_PORT})"
    info "  pm2-conf/dashboard.ini    enabled = ${pm_dash}   (janus-dashboard)"
    if [[ -f "${SCRIPT_DIR}/server/src/index.js" ]]; then
        ok "대시보드 서버 있음"
    else
        pend "대시보드 서버 없음: server/src/index.js — 계획서 3단계"
        pending=$((pending + 1))
    fi

    # --- 배포 설정: 저장한 값이 실제로 설치돼 있는가 ---
    #
    # 적용 기록이 아예 없으면 비교할 대상이 없다. 그때는 "다르다" 가 아니라
    # "모른다" 이므로 대기로 보고하지 않는다 (lib/settings.js 와 같은 규칙).
    info ""
    info "배포 설정 (settings.ini)"
    if [[ ! -r "$SETTINGS_FILE" ]]; then
        info "  파일이 없어 기본값으로 봅니다 (LAN 전용 · WebRTC ${DEFAULT_RTP_RANGE} · SIP ${DEFAULT_SIP_RTP_RANGE})."
        info "  값을 넣으려면 뼈대를 만들어 채우세요:  ${SETTINGS_INIT_CMD}"
        info "  (구축 마법사 /manager/setup 의 폼도 같은 파일을 씁니다)"
    fi
    if [[ -r "$APPLIED_FILE" ]]; then
        local key saved applied fallback
        for key in public_ip rtp_port_range sip_rtp_port_range sip_local_ip lan_iface; do
            # 키가 없으면 --apply 가 쓴 것과 같은 기본값으로 친다. 빈 값으로
            # 비교하면 settings.ini 가 없는 장비에서 언제나 어긋나 보인다.
            case "$key" in
                public_ip)          fallback="$DEFAULT_PUBLIC_IP" ;;
                rtp_port_range)     fallback="$DEFAULT_RTP_RANGE" ;;
                sip_rtp_port_range) fallback="$DEFAULT_SIP_RTP_RANGE" ;;
                # 이 둘은 settings.ini 에 없으면 감지한 값이 곧 설치될 값이다.
                sip_local_ip)   fallback="$SIP_LOCAL_IP" ;;
                lan_iface)      fallback="$LAN_IFACE" ;;
                *)              fallback="" ;;
            esac
            saved="$(settings_get "$key" "$fallback")"
            applied="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$APPLIED_FILE" | tail -1)"
            applied="${applied//[[:space:]]/}"
            if [[ "$saved" == "$applied" ]]; then
                ok "${key} = ${saved:-(비어 있음)}"
            else
                pend "${key} 가 아직 반영되지 않았습니다: 설치본 '${applied:-(비어 있음)}' → 저장한 값 '${saved:-(비어 있음)}' (sudo $0 --apply)"
                pending=$((pending + 1))
            fi
        done
    else
        info "  (적용 기록이 아직 없습니다 — --apply 를 한 번 돌리면 이후로는 어긋남을 알 수 있습니다)"
    fi

    info ""
    if [[ $problems -eq 0 && $pending -eq 0 ]]; then
        info "모두 준비됐습니다."
    else
        [[ $problems -gt 0 ]] && info "해결할 항목 ${problems}개 ([!!])"
        [[ $pending -gt 0 ]]  && info "아직 만들지 않은 항목 ${pending}개 ([--]) — 계획서 docs/plan.md 의 진행 순서를 따르세요"
    fi
    return 0
}

# ---------- 설치 ----------

BACKUPS=()

backup() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    local dest="${file}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -p "$file" "$dest"
    BACKUPS+=("$dest")
    info "  백업: ${dest}"
}

# 이번 실행에서 만든 백업으로 되돌린다. 백업이 없던 파일(처음 설치)은 지운다.
restore_backups() {
    local b f restored=()
    for b in "${BACKUPS[@]:-}"; do
        [[ -f "$b" ]] || continue
        f="${b%.bak.*}"
        cp -p "$b" "$f"
        restored+=("$f")
        info "  되돌림: ${f}"
    done

    local cfg target
    for cfg in "${OWNED_CFGS[@]}"; do
        target="${JANUS_ETC}/${cfg}"
        # 되돌린 목록에 없는데 우리 표식이 있으면, 이번에 처음 만든 것이다.
        if [[ -f "$target" ]] && grep -q "$CFG_MARKER" "$target" 2>/dev/null; then
            local found=false r
            for r in "${restored[@]:-}"; do [[ "$r" == "$target" ]] && found=true; done
            $found || { rm -f "$target"; info "  제거: ${target}"; }
        fi
    done
    return 0
}

# 영숫자 비밀번호를 만들어 파일에 넣는다. 이미 있으면 그대로 쓴다.
#
# ⚠️ 점검 모드에서는 절대 부르지 않는다. database/setup_mariadb.sh 는 --dry-run
#    에도 비밀번호 파일을 실제로 만들어, 파일과 DB 가 어긋나는 함정을 만들었다
#    (services/kamailio/README.md 7-2). 같은 실수를 반복하지 않는다.
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

apply() {
    require_root

    [[ -x "$JANUS_BIN" ]] || die "Janus 가 없습니다: ${JANUS_BIN}"
    [[ -d "$JANUS_ETC" ]] || die "설정 폴더가 없습니다: ${JANUS_ETC}"
    [[ -f "$SERVICE_TEMPLATE" ]] || die "systemd 유닛 원본이 없습니다: ${SERVICE_TEMPLATE}"
    local cfg
    for cfg in "${OWNED_CFGS[@]}"; do
        [[ -f "${SCRIPT_DIR}/${cfg}" ]] || die "설치할 원본이 없습니다: ${SCRIPT_DIR}/${cfg}"
    done

    echo "다음을 설치합니다:"
    echo "  ${JANUS_ETC}/{$(IFS=,; echo "${OWNED_CFGS[*]}")}"
    echo "  ${SERVICE_UNIT}   (systemd 유닛, enable + start)"
    echo "  ${PUBIP_UNIT}   (기동 직전 공인 IP 동기화)"
    echo "  ${SECRETS_DIR}/{admin-secret,api-secret}"
    echo
    echo "배포본 설정은 *.jcfg.sample 로 그대로 남고, 기존 파일은 백업합니다."
    confirm "계속할까요?" || { echo "취소했습니다."; exit 0; }

    # --- 실행 계정 ---
    if id "$JANUS_USER" &>/dev/null; then
        info "  이미 있음: 사용자 ${JANUS_USER}"
    else
        useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "$JANUS_USER"
        info "  생성: 시스템 사용자 ${JANUS_USER}"
    fi

    # --- 비밀 ---
    ensure_secret "$ADMIN_SECRET_FILE" "Admin API"
    ensure_secret "$API_SECRET_FILE" "시그널링 API"
    # sudo 로 만들었으므로 root 소유가 된다. 대시보드는 pm2 사용자로 뜨므로
    # 읽을 수 있어야 한다. database/setup_mariadb.sh 와 같은 처리다.
    if [[ -n "${SUDO_USER:-}" ]]; then
        chown -R "${SUDO_USER}:$(id -gn "$SUDO_USER")" "$SECRETS_DIR"
        info "  소유자: ${SUDO_USER} (대시보드가 읽어야 합니다)"
    fi

    local admin_secret api_secret
    admin_secret="$(head -1 "$ADMIN_SECRET_FILE" | tr -d '\r\n')"
    api_secret="$(head -1 "$API_SECRET_FILE" | tr -d '\r\n')"
    [[ -n "$admin_secret" && -n "$api_secret" ]] || die "비밀 파일이 비어 있습니다"

    # --- 배포 설정 ---
    #
    # 대시보드가 이 파일을 고칠 수 있으므로 **여기서 반드시 다시 검증한다.**
    # 대시보드를 우회해 손으로 고친 경우에도 같은 관문을 지나게 하려는 것이다.
    local public_ip rtp_range sip_rtp_range
    public_ip="$(settings_get public_ip "")"
    rtp_range="$(settings_get rtp_port_range "$DEFAULT_RTP_RANGE")"
    sip_rtp_range="$(settings_get sip_rtp_port_range "$DEFAULT_SIP_RTP_RANGE")"

    if [[ -n "$public_ip" ]]; then
        [[ "$public_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] \
            || die "settings.ini 의 public_ip 가 IPv4 로 보이지 않습니다: ${public_ip}"
        local o; for o in ${public_ip//./ }; do
            (( o <= 255 )) || die "settings.ini 의 public_ip 각 자리는 255 이하여야 합니다: ${public_ip}"
        done
        info "  공인 IP: ${public_ip} (nat_1_1_mapping 을 켭니다)"
    else
        info "  공인 IP: 없음 — LAN 전용으로 설치합니다 (nat_1_1_mapping 을 지웁니다)"
    fi

    [[ "$rtp_range" =~ ^[0-9]{4,5}-[0-9]{4,5}$ ]] \
        || die "settings.ini 의 rtp_port_range 형식이 맞지 않습니다 (예: 20000-20200): ${rtp_range}"
    local rlo="${rtp_range%-*}" rhi="${rtp_range#*-}"
    (( rlo < rhi ))        || die "settings.ini 의 rtp_port_range 는 시작이 끝보다 작아야 합니다: ${rtp_range}"
    (( rlo >= 1024 && rhi <= 65535 )) || die "settings.ini 의 rtp_port_range 는 1024~65535 안이어야 합니다: ${rtp_range}"
    info "  WebRTC 미디어 포트: ${rtp_range}"

    [[ "$sip_rtp_range" =~ ^[0-9]{4,5}-[0-9]{4,5}$ ]] \
        || die "settings.ini 의 sip_rtp_port_range 형식이 맞지 않습니다 (예: 30000-30200): ${sip_rtp_range}"
    local slo="${sip_rtp_range%-*}" shi="${sip_rtp_range#*-}"
    (( slo < shi ))        || die "settings.ini 의 sip_rtp_port_range 는 시작이 끝보다 작아야 합니다: ${sip_rtp_range}"
    (( slo >= 1024 && shi <= 65535 )) || die "settings.ini 의 sip_rtp_port_range 는 1024~65535 안이어야 합니다: ${sip_rtp_range}"
    ranges_overlap "$rlo" "$rhi" "$slo" "$shi" \
        && die "rtp_port_range(${rtp_range}) 와 sip_rtp_port_range(${sip_rtp_range}) 가 겹칩니다"
    info "  SIP 미디어 포트: ${sip_rtp_range}"

    # 값을 보여 주면서 바꾸는 법을 말하지 않으면, 읽는 사람은 그것이 고칠 수 있는
    # 값인지조차 알 수 없다. 대시보드가 아직 안 떠 있는 자리라서 더 그렇다.
    if [[ -r "$SETTINGS_FILE" ]]; then
        info "  ↳ 바꾸려면 ${SETTINGS_FILE} 를 고치고 이 명령을 다시 돌리세요."
    else
        info "  ↳ 이 둘은 settings.ini 에서 옵니다. 지금은 그 파일이 없어 기본값입니다."
        info "     바꾸려면 뼈대를 만들어 채운 뒤 이 명령을 다시 돌리세요 (커밋되지 않습니다):"
        info "         ${SETTINGS_INIT_CMD}"
    fi
    info "     대시보드가 떠 있으면 /janus/dashboard/settings 가 같은 파일을 씁니다."

    # --- 통화에 쓸 인터페이스 ---
    #
    # 박아 두지 않고 감지한다. 후보가 여럿이면 물어보고, 고른 값은 settings.ini
    # 에 적어 다음부터 묻지 않는다. --yes 는 사람이 없는 자리라 묻지 않고
    # 기본 경로 쪽을 쓴다.
    local ask="ask"
    if $ASSUME_YES; then ask=""; fi
    resolve_lan "$ask" || die "통화에 쓸 LAN 인터페이스를 찾지 못했습니다 (ip -4 addr 로 확인하세요)"
    info ""
    info "  통화에 쓸 인터페이스: ${LAN_IFACE} ${SIP_LOCAL_IP}"
    info "    SIP SDP 의 c= 주소와 ice_enforce_list 가 이 값으로 설치됩니다 (plan.md ③)"
    if [[ "$(settings_get lan_iface '')" != "$LAN_IFACE" || "$(settings_get sip_local_ip '')" != "$SIP_LOCAL_IP" ]]; then
        settings_put lan_iface "$LAN_IFACE"
        settings_put sip_local_ip "$SIP_LOCAL_IP"
        info "    settings.ini 에 적었습니다 — 바꾸려면 그 값을 고치고 다시 --apply 하세요"
    fi

    # --- 설정 ---
    local target mode owner
    for cfg in "${OWNED_CFGS[@]}"; do
        target="${JANUS_ETC}/${cfg}"
        backup "$target"

        # janus.jcfg 만 비밀을 담는다. 다른 사용자가 읽지 못하게 좁힌다.
        if [[ "$cfg" == "janus.jcfg" ]]; then
            mode=0640; owner="root:${JANUS_USER}"
        else
            mode=0644; owner="root:root"
        fi

        install -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "${SCRIPT_DIR}/${cfg}" "$target"
        sed -i "s/__ADMIN_SECRET__/${admin_secret}/; s/__API_SECRET__/${api_secret}/" "$target"

        if [[ "$cfg" == "janus.jcfg" ]]; then
            # 공인 IP — 있으면 켜고, 없으면 그 두 줄을 지운다 (LAN 전용).
            # 자리표시자가 남으면 Janus 가 그 문자열을 주소로 알아듣고 외부
            # 통화가 조용히 무음이 된다. 그래서 '지운다' 쪽을 기본으로 둔다.
            if [[ -n "$public_ip" ]]; then
                sed -i "s/__PUBLIC_IP__/${public_ip}/" "$target"
            else
                sed -i '/__PUBLIC_IP__/d; /^[[:space:]]*keep_private_host[[:space:]]*=/d' "$target"
            fi

            # 미디어 포트 범위 — 템플릿의 값을 설정값으로 덮어쓴다.
            # 자리표시자를 두지 않은 이유는 janus.jcfg 가 그 자체로 온전한
            # 설정으로 남아 있게 하기 위해서다 (그대로 복사해도 동작한다).
            sed -i "s|^\([[:space:]]*rtp_port_range[[:space:]]*=[[:space:]]*\)\"[0-9]\{1,\}-[0-9]\{1,\}\"|\1\"${rtp_range}\"|" "$target"

            # ICE 후보를 모을 인터페이스 — 같은 이유로 값을 덮어쓴다.
            sed -i "s|^\([[:space:]]*ice_enforce_list[[:space:]]*=[[:space:]]*\)\".*\"|\1\"${LAN_IFACE}\"|" "$target"
        fi

        if [[ "$cfg" == "janus.plugin.sip.jcfg" ]]; then
            # SIP 쪽 SDP 에 실릴 주소. 이것이 이 장비의 LAN 주소가 아니면
            # 시그널링은 되고 소리만 안 난다 (계획서 ③).
            sed -i "s|^\([[:space:]]*local_ip[[:space:]]*=[[:space:]]*\)\".*\"|\1\"${SIP_LOCAL_IP}\"|" "$target"

            # 미디어 포트 범위 — janus.jcfg 와 같은 이유로 값을 덮어쓴다.
            sed -i "s|^\([[:space:]]*rtp_port_range[[:space:]]*=[[:space:]]*\)\"[0-9]\{1,\}-[0-9]\{1,\}\"|\1\"${sip_rtp_range}\"|" "$target"
        fi
        info "  설치: ${target} (${mode})"
    done

    # --- 적용 기록 ---
    #
    # 무엇을 실제로 설치했는지 남긴다. 대시보드는 settings.ini 와 이것을 비교해
    # '저장은 됐지만 아직 반영 안 됨' 을 알린다. 설치된 janus.jcfg 는 0640
    # root:janus 라 대시보드가 읽을 수 없어, 대신 이 파일을 남기는 것이다.
    {
        echo "; install.sh --apply 가 마지막으로 설치한 값. 손으로 고치지 마세요."
        echo "public_ip = ${public_ip}"
        echo "rtp_port_range = ${rtp_range}"
        echo "sip_rtp_port_range = ${sip_rtp_range}"
        echo "sip_local_ip = ${SIP_LOCAL_IP}"
        echo "lan_iface = ${LAN_IFACE}"
    } > "$APPLIED_FILE"
    chmod 644 "$APPLIED_FILE"
    info "  적용 기록: ${APPLIED_FILE}"

    # --- systemd ---
    backup "$SERVICE_UNIT"
    install -o root -g root -m 644 "$SERVICE_TEMPLATE" "$SERVICE_UNIT"
    info "  설치: ${SERVICE_UNIT}"
    # 기동 직전 공인 IP 동기화. 저장소 위치를 유닛에 박아 넣는다 — systemd 는
    # 상대 경로도 ~ 도 풀어 주지 않는다.
    backup "$PUBIP_UNIT"
    install -o root -g root -m 644 "$PUBIP_TEMPLATE" "$PUBIP_UNIT"
    sed -i "s|__REPO_DIR__|${SCRIPT_DIR}|g" "$PUBIP_UNIT"
    info "  설치: ${PUBIP_UNIT}"
    systemctl daemon-reload
    systemctl enable janus >/dev/null 2>&1
    systemctl enable janus-public-ip >/dev/null 2>&1
    info "  enable: 재부팅 후에도 뜹니다 (기동 직전 공인 IP 동기화 포함)"

    # --- 기동 ---
    #
    # Janus 에는 kamailio -c 같은 설정 검사 모드가 없다. 그래서 실제로 띄워 보고
    # **응답까지** 확인한다. is-active 만 믿지 않는 이유는 Kamailio 에서
    # 포트도 열리고 is-active 도 정상인데 아무 응답이 없던 전례 때문이다
    # (docs/plan.md 위험 목록, kamailio/docs/websocket-plan.md ①-1).
    #
    # reset-failed 를 먼저 한다. 기동 실패가 반복되면 systemd 가 재시작 횟수
    # 제한에 걸어 "Start request repeated too quickly" 로 더 시도하지 않는다.
    systemctl reset-failed janus 2>/dev/null || true
    systemctl restart janus || true
    sleep 2

    local code=000 i
    for i in 1 2 3 4 5; do
        code="$(probe_http "http://127.0.0.1:${API_PORT}${API_BASE_PATH}/info")"
        [[ "$code" == "200" ]] && break
        sleep 1
    done

    if ! systemctl is-active --quiet janus || [[ "$code" != "200" ]]; then
        warn "기동에 실패했습니다 (is-active=$(systemctl is-active janus 2>/dev/null), ${API_BASE_PATH}/info=${code})"
        info "설정을 되돌립니다."
        restore_backups
        systemctl daemon-reload
        systemctl reset-failed janus 2>/dev/null || true
        echo
        journalctl -u janus -n 20 --no-pager 2>/dev/null | tail -20
        die "되돌렸습니다. 위 로그에서 원인을 확인하세요."
    fi

    ok "구동 중 — GET ${API_BASE_PATH}/info → 200"

    # 실제로 우리가 정한 대로 열렸는지 확인한다. 설정을 썼다는 것과 그렇게
    # 동작한다는 것은 다르다.
    local admin_addr ws_addr
    admin_addr="$(listen_addr "$ADMIN_PORT")"
    ws_addr="$(listen_addr "$WS_PORT")"
    [[ "$admin_addr" == 127.0.0.1:* ]] \
        && ok "Admin API: ${admin_addr} (루프백 전용)" \
        || warn "Admin API 가 예상과 다릅니다: ${admin_addr:-열려 있지 않음}"
    if [[ "$ws_addr" == 127.0.0.1:* ]]; then
        ok "WebSocket: ${ws_addr} (루프백 전용)"
    else
        warn "WebSocket 이 예상과 다릅니다: ${ws_addr:-열려 있지 않음}"
        [[ -e "${JANUS_PREFIX}/lib/janus/transports/libjanus_websockets.so" ]] \
            || warn "  libjanus_websockets.so 가 없습니다 — libwebsockets 없이 빌드됐습니다."
        [[ -e "${JANUS_PREFIX}/lib/janus/transports/libjanus_websockets.so" ]] \
            || warn "  sudo ./bootstrap.sh --install 뒤 소스에서 다시 빌드하고 --apply 를 다시 하세요."
    fi

    echo
    #echo "다음 단계 — 계획서 3단계 (대시보드 서비스와 라우트 개방):"
    #echo "  ${SCRIPT_DIR}/docs/plan.md"
    #echo
    #echo "지금은 루프백에서만 닿습니다. nginx-conf 가 아직 enabled = false 입니다."
}

# ---------- 되돌리기 ----------

remove() {
    require_root

    echo "Janus 를 멈추고 이 저장소가 설치한 설정과 유닛을 걷어냅니다."
    echo "  - 배포본 *.jcfg.sample 로 되돌립니다 (백업이 있으면 그쪽 우선)"
    echo "  - ${SECRETS_DIR} 는 지우지 않습니다 (다시 설치할 때 그대로 씁니다)"
    confirm "계속할까요?" || { echo "취소했습니다."; exit 0; }

    if [[ -f "$PUBIP_UNIT" ]]; then
        systemctl disable janus-public-ip 2>/dev/null || true
        rm -f "$PUBIP_UNIT"
        info "  제거: ${PUBIP_UNIT}"
    fi
    if [[ -f "$SERVICE_UNIT" ]]; then
        systemctl stop janus 2>/dev/null || true
        systemctl disable janus 2>/dev/null || true
        rm -f "$SERVICE_UNIT"
        systemctl daemon-reload
        systemctl reset-failed janus 2>/dev/null || true
        info "  제거: ${SERVICE_UNIT}"
    else
        info "  유닛이 설치되어 있지 않습니다"
    fi

    local cfg target newest
    for cfg in "${OWNED_CFGS[@]}"; do
        target="${JANUS_ETC}/${cfg}"
        [[ -f "$target" ]] || continue
        grep -q "$CFG_MARKER" "$target" 2>/dev/null || { info "  건너뜀(우리 것이 아님): ${target}"; continue; }

        # ls 를 파이프로 물리지 않는다. head 가 먼저 닫으면 pipefail 아래에서
        # 파이프라인 전체가 실패로 판정된다.
        newest="$(find "$JANUS_ETC" -maxdepth 1 -name "${cfg}.bak.*" -printf '%f\n' 2>/dev/null | sort | tail -1)"
        if [[ -n "$newest" ]]; then
            cp -p "${JANUS_ETC}/${newest}" "$target"
            info "  되돌림: ${target} ← ${newest}"
        elif [[ -f "${target}.sample" ]]; then
            install -o root -g root -m 644 "${target}.sample" "$target"
            info "  되돌림: ${target} ← 배포본 sample"
        else
            rm -f "$target"
            info "  제거: ${target}"
        fi
    done

    ok "걷어냈습니다. 상태 확인: $0"
}

case "$MODE" in
    check)  report; check_finish ;;
    apply)  apply ;;
    remove) remove ;;
esac
