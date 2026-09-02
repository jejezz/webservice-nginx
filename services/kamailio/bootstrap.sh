#!/usr/bin/env bash
#
# Kamailio 를 처음부터 세우는 절차를 한 곳에 모은 것.
#
#   ./bootstrap.sh              지금 어디까지 됐는지 점검한다 (아무것도 바꾸지 않음)
#   sudo ./bootstrap.sh --install   패키지 설치 + 그룹 설정까지 한다
#
# 이 스크립트가 존재하는 이유는 **재현 가능성** 때문입니다. 세우는 동안 손으로 한
# 일들(apt 설치, usermod, 순서)이 어디에도 적혀 있지 않으면, 새 장비에서 같은 것을
# 다시 만들 수 없습니다. 실제로 점검해 보니 다섯 군데가 비어 있었습니다.
#
# 설정을 실제로 바꾸는 일은 여기서 하지 않습니다 — 각 스크립트가 자기 확인 절차와
# 롤백을 갖고 있으므로, 여기서는 **무엇을 어떤 순서로 실행해야 하는지** 알려 줍니다.
#
#   install.sh           digest 인증 + SIP 도메인 + 착신 푸시 훅 (포크 설치)
#   setup-websocket.sh   SIP over WebSocket 전송
#   setup-dashboard.sh   관찰용 대시보드
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── 무엇이 왜 필요한가 ──────────────────────────────────────────────────────
#
# 모듈이 아니라 **기능** 기준으로 묶는다. 어떤 패키지를 왜 넣는지 보이지 않으면
# 나중에 지워도 되는지 판단할 수 없다.
#
#   패키지|모듈|무엇에 필요한가
FEATURES=(
    "kamailio|/usr/sbin/kamailio|SIP 서버 본체"
    "kamailio-mysql-modules|db_mysql|계정(subscriber) 조회 — digest 인증"
    "kamailio-websocket-modules|websocket|SIP over WebSocket — 모바일이 WSS 로 붙는다"
    "kamailio-utils-modules|http_client|착신 푸시 요청 — websocket-relay 호출"
)

# 배포판 kamailio 패키지에 이미 들어 있어 따로 설치할 것이 없는 모듈.
BUILTIN=(xhttp tsilo nathelper rtpengine dispatcher)
# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
source "${SCRIPT_DIR}/../../lib/check-report.sh"

# --json 은 아래 인자 파싱보다 **먼저** 걸러낸다.
check_init "kamailio.deps"
check_args "$@"
set -- "${CHECK_REST[@]:-}"


MODE="check"
ASSUME_YES=false
for arg in "$@"; do
    case "$arg" in
        --install) MODE="install" ;;
        --check)   MODE="check" ;;
        --yes|-y)  ASSUME_YES=true ;;
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $arg"; echo "Usage: $0 [--check|--install] [--yes]"; exit 1 ;;
    esac
done

die()  { echo "오류: $*" >&2; exit 1; }

confirm() {
    $ASSUME_YES && return 0
    read -r -p "$1 [y/N] " a
    [[ "$a" == "y" || "$a" == "Y" ]]
}

module_dir() {
    local bin
    bin="$(systemctl show kamailio -p ExecStart --value 2>/dev/null || true)"
    bin="$(sed -n 's/.*path=\([^ ;]*\).*/\1/p' <<<"$bin")"
    case "${bin%%$'\n'*}" in
        /usr/local/sbin/*) echo "/usr/local/lib64/kamailio/modules" ;;
        *)                 echo "/usr/lib/x86_64-linux-gnu/kamailio/modules" ;;
    esac
}

have_module() {
    [[ "$1" == /* ]] && { [[ -x "$1" ]]; return; }
    [[ -f "$(module_dir)/$1.so" ]]
}

pkg_installed() { dpkg -l "$1" 2>/dev/null | grep -q "^ii"; }

missing_packages() {
    local line pkg mod
    for line in "${FEATURES[@]}"; do
        IFS='|' read -r pkg mod _ <<<"$line"
        have_module "$mod" || echo "$pkg"
    done
}

# ── 점검 ────────────────────────────────────────────────────────────────────

report() {
    local problems=0 line pkg mod why

    info "1. 패키지"
    for line in "${FEATURES[@]}"; do
        IFS='|' read -r pkg mod why <<<"$line"
        if have_module "$mod"; then
            ok "$(printf '%-30s' "$pkg") ${why}"
        else
            pend "$(printf '%-30s' "$pkg") ${why}"
            problems=$((problems + 1))
        fi
    done
    local b
    for b in "${BUILTIN[@]}"; do
        have_module "$b" || warn "$b 가 없습니다 — 배포판 kamailio 에 들어 있어야 합니다"
    done

    info ""
    info "2. 그룹 (대시보드가 RPC FIFO 를 읽는 데 필요)"
    # || true 가 필요하다. set -e + pipefail 아래에서 그룹이 **없으면** getent 가 2 로
    # 끝나 대입문이 실패하고, 점검이 여기서 죽는다 — 그룹이 없는 상태야말로 이
    # 점검이 알려 주어야 하는 상태다.
    local gid; gid="$(getent group kamailio 2>/dev/null | cut -d: -f3 || true)"
    local target="${SUDO_USER:-$(id -un)}"
    if [[ -z "$gid" ]]; then
        pend "kamailio 그룹이 없습니다 (패키지 설치 전)"
        problems=$((problems + 1))
    else
        local members; members="$(getent group kamailio | cut -d: -f4 | tr ',' '\n')"
        if grep -qx "$target" <<<"$members"; then
            ok "${target} 가 kamailio 그룹에 있습니다"
        else
            pend "${target} 가 kamailio 그룹에 없습니다"
            info "         sudo usermod -aG kamailio ${target}   (또는 이 스크립트 --install)"
            problems=$((problems + 1))
        fi
    fi

    info ""
    info "3. 데이터베이스 (스키마는 database/database.ini 가 소유)"
    if [[ -r "${PROJECT_ROOT}/database/secrets/kamailio.pw" ]]; then
        ok "kamailio DB 비밀번호 파일 있음"
    else
        pend "없음 — cd ${PROJECT_ROOT}/database && sudo ./setup_mariadb.sh"
        problems=$((problems + 1))
    fi

    info ""
    info "4. 설정 (각 스크립트가 설치·검증·롤백을 한다)"
    if grep -q "KAMAILIO-FORK" /etc/kamailio/kamailio.cfg 2>/dev/null; then
        ok "kamailio.cfg — 포크 설치됨 (착신 푸시 훅 포함)"
    else
        pend "kamailio.cfg — 배포판 그대로.  sudo ./install.sh --apply"
        problems=$((problems + 1))
    fi
    if [[ -f /etc/kamailio/kamailio-websocket.cfg ]]; then
        ok "kamailio-websocket.cfg — WS 전송 설치됨"
    else
        skip "WS 설정 없음.  sudo ./setup-websocket.sh --enable"
        problems=$((problems + 1))
    fi

    info ""
    info "5. 동작"
    if systemctl is-active --quiet kamailio; then
        ok "kamailio 실행 중"
    else
        pend "kamailio 가 실행 중이 아닙니다"
        info "         sudo systemctl reset-failed kamailio && sudo systemctl start kamailio"
        problems=$((problems + 1))
    fi
    local code
    # || true 가 필요하다. WS 를 아직 켜지 않았으면 curl 이 7(연결 실패)로 끝나고,
    # set -e 아래에서는 그 대입문 하나가 스크립트를 통째로 끝낸다. 사람이 보는
    # 모드에서는 여기까지 찍힌 것이 남아 티가 안 나지만, --json 은 출력을 모아
    # check_finish 에서 한 번에 내므로 **아무것도 나오지 않는다.** 구축 마법사가
    # "점검 출력을 읽지 못했습니다" 를 띄운 원인이다.
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:5080/health 2>/dev/null || true)"
    [[ "${code:-000}" == "200" ]] && ok "WS 포트의 /health → 200" \
        || { skip "WS /health 응답 없음 (code=${code:-000})"; problems=$((problems + 1)); }

    info ""
    if [[ $problems -eq 0 ]]; then
        info "모두 준비됐습니다."
    else
        info "남은 항목 ${problems}개. 아래 순서대로 진행하세요."
        print_order
    fi
    return 0
}

# 사람이 보는 안내다. cat 으로 바로 찍으면 --json 모드에서도 stdout 에 섞여
# 나가 JSON 을 깨뜨린다 — info 를 거쳐야 JSON 모드에서 조용해진다.
print_order() {
    local line
    while IFS= read -r line; do info "$line"; done <<ORDER

── 처음부터 세우는 순서 ──────────────────────────────────────────────────

  1  sudo ./bootstrap.sh --install
       패키지 + kamailio 그룹. 여기까지는 설정을 건드리지 않는다.
       그룹은 **다시 로그인해야** 반영된다.

  2  cd ${PROJECT_ROOT}/database && sudo ./setup_mariadb.sh
       kamailio 스키마(subscriber)와 rtc_relay 의 sip_user 컬럼.

  3  cd ${SCRIPT_DIR} && sudo ./install.sh --apply
       digest 인증 · SIP 도메인(alias) · 5060 리스너 · 착신 푸시 훅.
       배포판 설정의 포크를 설치한다. 검사 실패 시 자동 롤백.

  4  sudo ./setup-websocket.sh --enable
       SIP over WebSocket(5080). handshake 까지 자동 검증한다.

  5  ${SCRIPT_DIR}/nginx-conf/service.ini 를 enabled = true 로 두고
     cd ${PROJECT_ROOT} && sudo ./nginx/install_nginx_stack.sh --skip-install
       wss://<공인IP>:28443/sip/ 경로를 연다.

  6  cd ${SCRIPT_DIR} && ./setup-dashboard.sh --build
       관찰용 대시보드 빌드.

  7  pm2 kill && cd ${PROJECT_ROOT}/pm2 && pm2 start ecosystem.config.js && pm2 save
       **1 이후 다시 로그인한 뒤** 실행해야 대시보드가 kamailio 그룹을 받는다.

  8  ./bootstrap.sh
       전부 초록인지 확인.

  이 밖에 저장소 밖에서 해야 하는 것:
    · 공유기 포워딩 — 30000-30500/udp (rtpengine, 미디어 도입 시)
    · rtpengine 데몬 — 배포판에 없음. rtpengine.conf 참고
    · 단말 앱 — /register 에 sipUser 를 함께 보내야 착신 푸시가 간다
ORDER
}

# ── 설치 ────────────────────────────────────────────────────────────────────

install_all() {
    [[ "$(id -u)" -eq 0 ]] || die "sudo 로 실행하세요."

    local pkgs=() p
    mapfile -t pkgs < <(missing_packages)
    local filtered=(); for p in "${pkgs[@]}"; do [[ -n "$p" ]] && filtered+=("$p"); done
    pkgs=("${filtered[@]}")

    if [[ ${#pkgs[@]} -gt 0 ]]; then
        echo
        echo "설치할 패키지:"
        local line pkg mod why
        for p in "${pkgs[@]}"; do
            for line in "${FEATURES[@]}"; do
                IFS='|' read -r pkg mod why <<<"$line"
                [[ "$pkg" == "$p" ]] && printf '  %-30s %s\n' "$pkg" "$why"
            done
        done
        echo
        echo "패키지만 설치합니다 — 설정과 실행 중인 서비스는 건드리지 않습니다."
        confirm "진행할까요?" || { echo "취소했습니다."; exit 0; }
        apt-get install -y "${pkgs[@]}"
    else
        info "필요한 패키지가 모두 설치되어 있습니다."
    fi

    # 대시보드가 RPC FIFO(/run/kamailio, drwxrwx--- kamailio)를 읽으려면 그룹이 필요하다.
    local target="${SUDO_USER:-}"
    if [[ -z "$target" ]]; then
        warn "SUDO_USER 가 없어 그룹을 설정할 대상을 알 수 없습니다."
        warn "  직접 실행하세요: sudo usermod -aG kamailio <pm2 를 돌리는 사용자>"
    elif getent group kamailio | cut -d: -f4 | tr ',' '\n' | grep -qx "$target"; then
        ok "${target} 는 이미 kamailio 그룹입니다"
    else
        usermod -aG kamailio "$target"
        ok "${target} 를 kamailio 그룹에 추가했습니다"
        echo
        warn "⚠️ **다시 로그인해야 반영됩니다.**"
        warn "   보조 그룹은 로그인할 때 정해져서, 지금 떠 있는 셸과 그 셸이 띄운"
        warn "   pm2 데몬은 옛 그룹을 그대로 씁니다. usermod 만 하고 pm2 를 재시작해도"
        warn "   대시보드가 Kamailio 에 닿지 못합니다 — 실제로 겪은 함정입니다."
    fi

    echo
    report
}

case "$MODE" in
    check)   report; check_finish ;;
    install) install_all ;;
esac
