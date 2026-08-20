#!/usr/bin/env bash
#
# janus-dashboard 를 점검하고 빌드한다. sudo 가 필요 없다.
#
#   ./setup-dashboard.sh           점검만 (의존성 · 빌드 · janus.js · 프로세스)
#   ./setup-dashboard.sh --build   의존성 설치 + janus.js 복사 + 프런트 빌드 + 점검
#
# Janus 자체의 설치·설정은 install.sh 가 sudo 로 한다. 이 스크립트는
# 대시보드 프로세스가 쓸 것만 다룬다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JANUS_PREFIX="/opt/janus"
# 번들에 넣지 않고 설치된 Janus 것을 복사한다. 버전이 어긋나면 조용히 실패하기
# 때문이다 (docs/plan.md 의 "janus.js 는 커밋하지 않는다").
JANUS_JS_SRC="${JANUS_PREFIX}/share/janus/javascript/janus.js"
JANUS_JS_DST="${SCRIPT_DIR}/web/public/janus.js"
DASHBOARD_PORT=28087

MODE="check"
for arg in "$@"; do
    case "$arg" in
        --build) MODE="build" ;;
        --check) MODE="check" ;;
        *) echo "Unknown option: $arg"; echo "Usage: $0 [--check|--build]"; exit 1 ;;
    esac
done

ok()   { echo "  [ok]   $*"; }
no()   { echo "  [--]   $*"; }
warn() { echo "  [!!]   $*"; }
die()  { echo "오류: $*" >&2; exit 1; }

# curl 은 연결 실패에도 %{http_code} 로 "000" 을 찍고 종료 코드만 0 이 아니다.
# `|| echo 000` 를 붙이면 "000000" 이 되어 버린다. 종료 코드는 무시하고
# 출력만 쓴다.
probe_http() {
    local out
    out="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)" || true
    echo "${out:-000}"
}

copy_janus_js() {
    [[ -f "$JANUS_JS_SRC" ]] || die "janus.js 를 찾지 못했습니다: ${JANUS_JS_SRC}"
    mkdir -p "$(dirname "$JANUS_JS_DST")"
    cp "$JANUS_JS_SRC" "$JANUS_JS_DST"
    echo "  복사: ${JANUS_JS_SRC} → web/public/janus.js"
}

build() {
    command -v npm >/dev/null || die "npm 이 필요합니다"

    echo "janus.js 가져오기"
    copy_janus_js

    echo
    echo "server 의존성"
    ( cd "${SCRIPT_DIR}/server" && npm install --no-audit --no-fund )

    echo
    echo "web 의존성"
    ( cd "${SCRIPT_DIR}/web" && npm install --no-audit --no-fund )

    echo
    echo "프런트 빌드"
    ( cd "${SCRIPT_DIR}/web" && npm run build )

    echo
    report
}

report() {
    local problems=0

    echo "대시보드 (janus-dashboard)"

    [[ -d "${SCRIPT_DIR}/server/node_modules" ]] \
        && ok "server 의존성 설치됨" \
        || { no "server 의존성 없음 → $0 --build"; problems=$((problems + 1)); }

    [[ -d "${SCRIPT_DIR}/web/node_modules" ]] \
        && ok "web 의존성 설치됨" \
        || { no "web 의존성 없음 → $0 --build"; problems=$((problems + 1)); }

    if [[ -f "${SCRIPT_DIR}/web/dist/index.html" ]]; then
        ok "프런트 빌드 있음 (web/dist)"
    else
        no "프런트 빌드 없음 → $0 --build"
        problems=$((problems + 1))
    fi

    if [[ -f "$JANUS_JS_DST" ]]; then
        if cmp -s "$JANUS_JS_SRC" "$JANUS_JS_DST"; then
            ok "janus.js 가 설치된 Janus 의 것과 같습니다"
        else
            # 조용히 실패하는 종류다. Janus 를 올린 뒤 빌드를 다시 하지 않으면
            # 라이브러리와 서버 버전이 어긋난다.
            warn "janus.js 가 ${JANUS_JS_SRC} 와 다릅니다 → $0 --build 로 다시 복사하세요"
            problems=$((problems + 1))
        fi
    else
        no "janus.js 없음 (web/public/janus.js) → $0 --build"
        problems=$((problems + 1))
    fi

    echo
    echo "프로세스"
    if command -v pm2 >/dev/null && pm2 pid janus-dashboard >/dev/null 2>&1 \
       && [[ -n "$(pm2 pid janus-dashboard 2>/dev/null | tr -d '[:space:]')" ]]; then
        ok "pm2 에 떠 있습니다 (pid $(pm2 pid janus-dashboard | tr -d '[:space:]'))"
    else
        no "pm2 에 떠 있지 않습니다"
        # 선언이 꺼져 있는 것과 아직 안 띄운 것은 할 일이 다르다.
        if grep -qE '^[[:space:]]*enabled[[:space:]]*=[[:space:]]*false' "${SCRIPT_DIR}/pm2-conf/dashboard.ini"; then
            echo "         pm2-conf/dashboard.ini 의 enabled 를 true 로 바꾼 뒤:"
        else
            echo "         선언은 켜져 있습니다. 띄우려면:"
        fi
        echo "         cd pm2 && pm2 start ecosystem.config.js --only janus-dashboard && pm2 save"
    fi

    local code
    code="$(probe_http "http://127.0.0.1:${DASHBOARD_PORT}/health")"
    if [[ "$code" == "200" ]]; then
        ok "/health → 200 (127.0.0.1:${DASHBOARD_PORT})"
    else
        no "/health 응답 없음 (HTTP ${code})"
    fi

    echo
    if [[ $problems -eq 0 ]]; then
        echo "빌드는 준비됐습니다."
    else
        echo "해결할 항목 ${problems}개."
    fi
    return 0
}

case "$MODE" in
    check) report ;;
    build) build ;;
esac
