#!/usr/bin/env bash
#
# coturn-dashboard 를 점검하고 빌드한다. sudo 가 필요 없다.
#
#   ./setup-dashboard.sh           점검만 (의존성 · 빌드 · 프로세스 · /health)
#   ./setup-dashboard.sh --build   server/web 의존성 설치 + 프런트 빌드 + 점검
#
# coturn 자체(패키지 설치·설정 적용)는 install.sh 가 sudo 로 한다. 이
# 스크립트는 대시보드 프로세스가 쓸 것만 다룬다 — janus·kamailio 와 달리
# 외부 클라이언트 라이브러리를 받아 올 일도(janus.js 같은 것), 특별한
# 그룹 권한도 필요 없다. coturn 상태는 systemctl·journalctl 로만 읽으므로
# (turnserver.conf 의 no-cli, server/src/coturn.js) 유닉스 소켓도 FIFO 도
# 맞출 필요가 없다 — 그래서 이 파일이 janus/setup-dashboard.sh 보다 짧다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="coturn-dashboard"
DASHBOARD_PORT=28092
# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
source "${SCRIPT_DIR}/../../lib/check-report.sh"

# --json 은 아래 인자 파싱보다 먼저 걸러낸다.
check_init "coturn.dashboard"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

MODE="check"
for arg in "$@"; do
    case "$arg" in
        --build) MODE="build" ;;
        --check) MODE="check" ;;
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $arg"; echo "Usage: $0 [--check|--build]"; exit 1 ;;
    esac
done

die() { echo "오류: $*" >&2; exit 1; }

# curl 은 연결 실패에도 빈 문자열을 낼 뿐 종료 코드만 0이 아니다.
# 종료 코드는 무시하고 본문만 본다 — janus/setup-dashboard.sh 의 probe_http 와
# 같은 이유(연결 실패와 "몸통이 비었다"를 구분할 필요가 없는 자리라 단순화했다).
probe_http() {
    curl -s -m 3 "$1" 2>/dev/null || true
}

build() {
    command -v npm >/dev/null || die "npm 이 필요합니다"

    echo "server 의존성"
    ( cd "${SCRIPT_DIR}/server" && npm install --no-audit --no-fund )

    echo
    echo "web 의존성 + 빌드"
    ( cd "${SCRIPT_DIR}/web" && npm install --no-audit --no-fund && npm run build )

    echo
    report
}

report() {
    local problems=0

    info "대시보드 (${APP_NAME})"

    [[ -d "${SCRIPT_DIR}/server/node_modules" ]] \
        && ok "server 의존성 설치됨" \
        || { pend "server 의존성 없음 → $0 --build"; problems=$((problems + 1)); }

    [[ -d "${SCRIPT_DIR}/web/node_modules" ]] \
        && ok "web 의존성 설치됨" \
        || { pend "web 의존성 없음 → $0 --build"; problems=$((problems + 1)); }

    if [[ -f "${SCRIPT_DIR}/web/dist/index.html" ]]; then
        ok "프런트 빌드 있음 (web/dist)"
    else
        pend "프런트 빌드 없음 → $0 --build"
        problems=$((problems + 1))
    fi

    info
    info "프로세스"
    if command -v pm2 >/dev/null && [[ -n "$(pm2 pid "$APP_NAME" 2>/dev/null | tr -d '[:space:]')" ]]; then
        ok "pm2 에 떠 있습니다 (pid $(pm2 pid "$APP_NAME" | tr -d '[:space:]'))"
    else
        pend "pm2 에 떠 있지 않습니다"
        if grep -qE '^[[:space:]]*enabled[[:space:]]*=[[:space:]]*false' "${SCRIPT_DIR}/pm2-conf/dashboard.ini"; then
            info "         pm2-conf/dashboard.ini 의 enabled 를 true 로 바꾼 뒤:"
        else
            info "         선언은 켜져 있습니다. 띄우려면:"
        fi
        info "         cd pm2 && pm2 start ecosystem.config.js --only ${APP_NAME} && pm2 save"
    fi

    # /health 가 이미 coturn 패키지·서비스 상태·설정 비교를 판정해 둔다
    # (server/src/coturn.js) — 여기서 같은 판정을 다시 만들지 않는다. 설정
    # 파일 하나를 진실로 삼는 것과 같은 이유다 (janus/install.sh 의
    # jcfg_rtp_range 주석 참고). 문자열만 가볍게 훑는다 — 이 응답은 이
    # 저장소가 직접 만드는 것이라 형식이 갑자기 바뀔 일이 없다.
    local body
    body="$(probe_http "http://127.0.0.1:${DASHBOARD_PORT}/health")"
    if [[ -z "$body" ]]; then
        pend "/health 응답 없음 (127.0.0.1:${DASHBOARD_PORT}) — 대시보드가 아직 안 떠 있으면 위부터 해결하세요"
        problems=$((problems + 1))
    else
        ok "/health 응답 있음 (127.0.0.1:${DASHBOARD_PORT})"

        if grep -q '"serviceState":"active"' <<<"$body"; then
            ok "coturn 서비스 상태: active"
        else
            warn "coturn 서비스가 active 가 아닙니다 → sudo services/coturn/install.sh --apply 를 확인하세요"
            problems=$((problems + 1))
        fi

        grep -q '"packageInstalled":true' <<<"$body" \
            || { warn "coturn 패키지가 설치돼 있지 않습니다 → sudo services/coturn/install.sh --apply"; problems=$((problems + 1)); }

        if grep -q '"config":"same"' <<<"$body"; then
            ok "설치된 /etc/turnserver.conf 가 저장소 선언과 같습니다"
        else
            warn "/etc/turnserver.conf 가 저장소 선언과 다르거나 확인할 수 없습니다 → sudo services/coturn/install.sh --apply"
            problems=$((problems + 1))
        fi
    fi

    info
    if [[ $problems -eq 0 ]]; then
        info "준비 완료. https://<서버>/coturn/dashboard"
    else
        info "해결할 항목 ${problems}개."
    fi
    return 0
}

case "$MODE" in
    check) report; check_finish ;;
    build) build ;;
esac
