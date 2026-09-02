#!/usr/bin/env bash
#
# Janus 를 처음부터 세우는 절차를 한 곳에 모은 것 (계획서 10-2).
#
#   ./bootstrap.sh              지금 어디까지 됐는지 점검한다 (아무것도 바꾸지 않음)
#   sudo ./bootstrap.sh --install   빌드 의존성 패키지만 설치한다
#
# 이 스크립트가 존재하는 이유는 **재현 가능성** 입니다. 세우는 동안 손으로 한
# 일들(apt 설치, 소스 빌드 플래그, 순서)이 어디에도 적혀 있지 않으면 새 장비에서
# 같은 것을 다시 만들 수 없습니다. kamailio/bootstrap.sh 와 같은 자세입니다.
#
# 설정을 실제로 바꾸는 일은 여기서 하지 않습니다 — 각 스크립트가 자기 확인
# 절차와 롤백을 갖고 있으므로, 여기서는 **무엇을 어떤 순서로 실행해야 하는지**
# 알려 줍니다.
#
#   install.sh           .jcfg 넷 + systemd 유닛 설치 (sudo)
#   setup-dashboard.sh   대시보드 의존성 · janus.js · 프런트 빌드
#   verify-call.sh       5단계 시험 통화
#   verify-bridge.sh     6단계 WebRTC ↔ 평문 RTP 브리징
#
# ⚠️ **Janus 자체는 이 스크립트가 빌드하지 않습니다.** 소스 빌드는 시간이 오래
#    걸리고 실패 지점이 많아 사람이 보면서 해야 합니다. 대신 필요한 것과 정확한
#    configure 플래그를 알려 줍니다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
JANUS_PREFIX="/opt/janus"
JANUS_BIN="${JANUS_PREFIX}/bin/janus"
JANUS_SRC="${JANUS_SRC:-${HOME}/Public/RetroLink/janus-gateway}"

# 이 서버에서 실제로 쓴 플래그. plan.md 의 "지금 있는 것과 없는 것" 과 같아야 한다.
CONFIGURE_FLAGS="--prefix=${JANUS_PREFIX} --enable-post-processing --enable-data-channels"

# ── 무엇이 왜 필요한가 ──────────────────────────────────────────────────
#
# 라이브러리가 아니라 **기능** 기준으로 묶는다. 어떤 패키지를 왜 넣는지 보이지
# 않으면 나중에 지워도 되는지 판단할 수 없다.
#
# 목록은 짐작이 아니라 실측이다 — 설치된 바이너리와 .so 가 무엇에 링크돼
# 있는지 ldd 로 확인해서 뽑았다.
#
#   패키지|무엇에 필요한가
BUILD_DEPS=(
    "libglib2.0-dev|Janus 본체 (이벤트 루프·자료구조)"
    "libjansson-dev|JSON — Janus API 전체가 이것으로 오간다"
    "libnice-dev|ICE — WebRTC 후보 수집과 연결"
    "libsrtp2-dev|SRTP — WebRTC 미디어 암·복호"
    "libssl-dev|DTLS · TLS"
    "libusrsctp-dev|데이터 채널 (--enable-data-channels) — 없으면 configure 가 여기서 멈춘다"
    "libconfig-dev|.jcfg 설정 파일 파싱"
    "libcurl4-openssl-dev|Janus 본체가 쓰는 HTTP 클라이언트"
    "libmicrohttpd-dev|HTTP 트랜스포트 (libjanus_http.so) — /janus-api 가 여기로 온다"
    "libsofia-sip-ua-dev|SIP 플러그인 (libjanus_sip.so) — 이 게이트웨이의 핵심"
    "libopus-dev|Opus 코덱"
    "libogg-dev|녹음(post-processing)"
    "libtool|빌드"
    "automake|빌드"
    "build-essential|빌드"
    "pkg-config|빌드"
)

# 시험 도구. 없어도 Janus 는 돌지만 verify-*.sh 가 못 돈다.
#
# 이쪽은 **패키지가 아니라 실행 파일로** 본다. node·npm 은 배포판 패키지가
# 아니라 nodesource 로 들어오는 일이 흔해서, dpkg 로 보면 있는데도 없다고 나온다.
#
#   실행 파일|무엇에 필요한가
TEST_TOOLS=(
    "node|대시보드 서버 · 시험 하니스"
    "npm|대시보드 빌드"
    "google-chrome|헤드리스 시험 통화 (verify-call.sh · verify-bridge.sh)"
)
# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
source "${SCRIPT_DIR}/../../lib/check-report.sh"

# --json 은 아래 인자 파싱보다 **먼저** 걸러낸다.
check_init "janus.deps"
check_args "$@"
set -- "${CHECK_REST[@]:-}"


MODE="check"
for a in "${@:-}"; do
    case "$a" in
        --install) MODE="install" ;;
        --check|"") MODE="check" ;;
        -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $a" >&2; exit 1 ;;
    esac
done

# warn 은 공용 규약의 것을 쓰고, 이 스크립트의 카운터도 함께 올린다.
_warn_lib=$(declare -f warn); warn() { _check_add problem "$*"; [[ $CHECK_JSON -eq 1 ]] || echo "  [!!]   $*"; PROBLEMS=$((PROBLEMS + 1)); }
die()  { echo "오류: $*" >&2; exit 1; }
PROBLEMS=0

pkg_installed() { dpkg -l "$1" 2>/dev/null | grep -q "^ii"; }

missing_from() {
    local -n arr="$1"; local entry pkg out=()
    for entry in "${arr[@]}"; do
        pkg="${entry%%|*}"
        pkg_installed "$pkg" || out+=("$pkg")
    done
    echo "${out[*]:-}"
}

# ── 점검 ────────────────────────────────────────────────────────────────
report() {
    info "Janus 본체"
    if [[ -x "$JANUS_BIN" ]]; then
        ok "설치됨: ${JANUS_BIN} ($("$JANUS_BIN" --version 2>/dev/null | sed -n 's/^Janus version: //p'))"
    else
        warn "없습니다: ${JANUS_BIN}"
        info "         소스에서 빌드해야 합니다 (아래 '순서' 참고)"
    fi
    for m in plugins/libjanus_sip.so transports/libjanus_http.so; do
        [[ -f "${JANUS_PREFIX}/lib/janus/${m}" ]] && ok "$(basename "$m")" || warn "$(basename "$m") 가 없습니다"
    done

    info
    info "빌드 의존성"
    local miss; miss="$(missing_from BUILD_DEPS)"
    if [[ -z "$miss" ]]; then
        ok "${#BUILD_DEPS[@]}개 모두 설치됨"
    else
        warn "빠진 것: ${miss}"
        info "         sudo ./bootstrap.sh --install"
    fi

    info
    info "시험 도구"
    local entry tool tmiss=()
    for entry in "${TEST_TOOLS[@]}"; do
        tool="${entry%%|*}"
        command -v "$tool" >/dev/null 2>&1 \
            || command -v "${tool}-stable" >/dev/null 2>&1 \
            || tmiss+=("$tool")
    done
    if [[ ${#tmiss[@]} -eq 0 ]]; then
        ok "node $(node --version 2>/dev/null) · npm · 크롬"
    else
        skip "빠진 것: ${tmiss[*]} — Janus 는 돌지만 verify-*.sh 가 못 돕니다"
    fi

    info
    info "연동 대상"
    systemctl is-active --quiet kamailio && ok "Kamailio 구동 중" \
        || warn "Kamailio 가 떠 있지 않습니다 — services/kamailio/bootstrap.sh"
    if pgrep -x rtpproxy >/dev/null 2>&1; then
        ok "rtpproxy 구동 중 ($(pgrep -af rtpproxy | grep -oE '\-m [0-9]+ -M [0-9]+' | head -1))"
    else
        warn "rtpproxy 가 없습니다 — Kamailio 가 NAT 로 판정한 통화의 미디어를 중계합니다"
    fi

    info
    info "이 저장소가 만드는 것"
    [[ -f "${SCRIPT_DIR}/secrets/admin-secret" ]] && ok "secrets/ (install.sh --apply 가 만듭니다)" \
        || pend "secrets/ 없음 — 아직 install.sh --apply 를 안 돌렸습니다"
    [[ -d "${SCRIPT_DIR}/web/dist" ]] && ok "web/dist (setup-dashboard.sh --build)" \
        || pend "web/dist 없음 — 대시보드 경로가 503 이 됩니다"
    [[ -f "${SCRIPT_DIR}/settings.ini" ]] && ok "settings.ini (대시보드 '설정' 화면)" \
        || skip "settings.ini 없음 — LAN 전용으로 설치됩니다 (9단계)"
}

print_order() {
    cat <<ORDER

빈 장비에서 세우는 순서
───────────────────────────────────────────────────────────────────────

 0. 이 저장소를 받고, Kamailio 를 먼저 세운다
        services/kamailio/bootstrap.sh   ← SIP 코어가 없으면 Janus 는 할 일이 없다

 1. 빌드 의존성
        sudo ./bootstrap.sh --install

 2. Janus 를 소스에서 빌드한다  ⚠️ 사람이 보면서
        git clone https://github.com/meetecho/janus-gateway ${JANUS_SRC}
        cd ${JANUS_SRC}
        sh autogen.sh
        ./configure ${CONFIGURE_FLAGS}
        make && sudo make install && sudo make configs

    이 서버는 v1.4.0-5-gae0078e1 을 위 플래그로 빌드했습니다. configure 끝의
    요약에서 **SIP plugin 과 REST(HTTP) transport 가 yes** 인지 꼭 보세요 —
    아니면 libsofia-sip-ua-dev · libmicrohttpd-dev 가 빠진 것입니다.

 3. 설정과 systemd 유닛
        sudo ./install.sh --apply        # 실패하면 자동 롤백

 4. 대시보드
        ./setup-dashboard.sh --build
        cd ${PROJECT_ROOT}/pm2 && pm2 start ecosystem.config.js --only janus-dashboard && pm2 save

 5. nginx 라우트
        sudo ${PROJECT_ROOT}/nginx/install_nginx_stack.sh --skip-install

    ⚠️ **순서가 있습니다.** Janus 를 먼저 띄우고 nginx 를 반영하세요.
       뒤집으면 /janus-api 가 502 이고 manager 에 중단으로 뜹니다.

 6. SIP 계정 — **사람이 만듭니다** (스크립트가 만들지 않습니다)
        https://<서버>/kamailio/dashboard  →  SIP 계정  →  추가
        비밀번호를 secrets/sip-<사용자>.pw 에 두면 verify-*.sh 가 씁니다.
        (규약: services/kamailio/accounts.md)

 7. 확인
        ./verify-call.sh --run           # 브라우저 ↔ 브라우저
        ./verify-bridge.sh --run         # 브라우저 ↔ 평문 RTP 단말

 8. 외부에서 받으려면 (선택)
        대시보드 '설정' 화면에서 공인 IP · 미디어 포트 범위를 넣고 저장
        sudo ./install.sh --apply
        공유기에서 그 범위를 UDP 로 포워딩

ORDER
}

install_deps() {
    [[ $EUID -eq 0 ]] || die "패키지 설치에는 sudo 가 필요합니다"
    local miss; miss="$(missing_from BUILD_DEPS)"
    if [[ -z "$miss" ]]; then
        echo "빌드 의존성은 이미 모두 설치돼 있습니다."
        return 0
    fi
    echo "설치할 것: ${miss}"
    # shellcheck disable=SC2086
    apt-get install -y $miss
    echo
    echo "다음은 Janus 소스 빌드입니다 — ./bootstrap.sh 로 순서를 다시 보세요."
}

if [[ "$MODE" == "install" ]]; then
    install_deps
    exit 0
fi

report
check_finish            # --json 이면 여기서 끝난다 (순서 안내는 사람용이다)
print_order
echo
if [[ $PROBLEMS -gt 0 ]]; then
    echo "점검: [!!] ${PROBLEMS}개. 위 순서대로 채우세요."
    exit 1
fi
echo "점검: 빈 장비에서 재현할 준비가 돼 있습니다."
