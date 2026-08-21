#!/usr/bin/env bash
#
# 계획서 5단계 — 브라우저 ↔ 브라우저 시험 통화를 사람 없이 돌린다. sudo 가 필요 없다.
#
#   ./verify-call.sh                     점검만 (아무 전화도 걸지 않는다)
#   ./verify-call.sh --run               2001 → 2003 으로 실제 통화
#   ./verify-call.sh --run --from 2001 --to 2003
#
# 무엇을 확인하는가 — 협상이 됐는지가 아니라 **소리가 흘렀는지**까지 본다.
#
#   5-1  둘 다 REGISTER 되는가
#   5-2  발신 → 착신 → 수락이 이어지는가
#   5-3  RTP 가 양방향으로 실제로 오는가 (getStats 의 inbound-rtp.packetsReceived)
#   5-4  끊긴 뒤 다시 걸리는가
#
# "연결됨인데 소리가 안 난다" 가 이 게이트웨이에서 가장 자주 만나는 실패 모양이라
# (docs/plan.md ③), 사람 귀 대신 패킷 수로 판정한다.
#
# 탭 둘을 손으로 여는 대신 헤드리스 크롬 하나에서 janus.js 세션 둘을 띄운다.
# 마이크는 --use-fake-device-for-media-stream 이 만드는 440Hz 톤을 쓴다.
# 대시보드의 /janus/dashboard/test-call 을 쓰지 않는 이유는 그 페이지가 manager
# 로그인 세션을 요구하기 때문이다 — 자동화하려면 사람의 비밀번호를 다뤄야 한다.
#
# ⚠️ 이 시험은 양쪽이 다 크롬이라 **opus** 로 붙는다. ⑥의 PCMU/PCMA 브리징은
#    여기서 검증되지 않는다 — 그것은 6단계(소프트폰)의 몫이다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="${SCRIPT_DIR}/test-harness"
SECRETS_DIR="${SCRIPT_DIR}/secrets"
OUTDIR="${HARNESS_DIR}/last-run"

JANUS_JS_SRC="${JANUS_JS_PATH:-/opt/janus/share/janus/javascript/janus.js}"
ADAPTER_JS="${SCRIPT_DIR}/web/node_modules/webrtc-adapter/out/adapter.js"
JANUS_HTTP_PORT="${JANUS_HTTP_PORT:-8088}"
HARNESS_PORT="${HARNESS_PORT:-28199}"

# SIP 쪽 기본값은 server/src/config.js 와 같게 둔다. 다르면 등록부터 실패한다.
SIP_DOMAIN="${SIP_DOMAIN:-pluto.org}"
SIP_PROXY="${SIP_PROXY:-sip:192.168.0.252:5060}"

MODE="check"
FROM_USER="2001"
TO_USER="2003"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --run)   MODE="run"; shift ;;
        --check) MODE="check"; shift ;;
        --from)  FROM_USER="${2:?--from 에 사용자명이 필요합니다}"; shift 2 ;;
        --to)    TO_USER="${2:?--to 에 사용자명이 필요합니다}"; shift 2 ;;
        -h|--help)
            sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "Unknown option: $1"; echo "Usage: $0 [--check|--run] [--from USER] [--to USER]"; exit 1 ;;
    esac
done

ok()   { echo "  [ok]   $*"; }
no()   { echo "  [--]   $*"; }
warn() { echo "  [!!]   $*"; PROBLEMS=$((PROBLEMS + 1)); }
die()  { echo "오류: $*" >&2; exit 1; }
PROBLEMS=0

pw_file() { echo "${SECRETS_DIR}/sip-$1.pw"; }

# curl 은 연결 실패에도 종료 코드만 0 이 아니고 %{http_code} 로 "000" 을 찍는다.
probe_http() {
    local out
    out="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)" || true
    echo "${out:-000}"
}

find_chrome() {
    local c
    for c in google-chrome chromium chromium-browser; do
        if command -v "$c" >/dev/null 2>&1; then echo "$c"; return 0; fi
    done
    return 1
}

# ── 점검 ────────────────────────────────────────────────────────────────
echo "도구"
command -v node >/dev/null && ok "node $(node --version)" || warn "node 가 없습니다"
if CHROME="$(find_chrome)"; then
    ok "브라우저 ${CHROME}"
else
    CHROME=""
    warn "크롬이 없습니다 — google-chrome / chromium 중 하나가 필요합니다"
fi

echo
echo "자원"
[[ -f "$JANUS_JS_SRC" ]] && ok "janus.js ${JANUS_JS_SRC}" \
    || warn "janus.js 를 찾지 못했습니다: ${JANUS_JS_SRC}"
[[ -f "$ADAPTER_JS" ]] && ok "webrtc-adapter" \
    || warn "webrtc-adapter 가 없습니다 — ./setup-dashboard.sh --build 를 먼저 도세요"

echo
echo "Janus"
INFO_CODE="$(probe_http "http://127.0.0.1:${JANUS_HTTP_PORT}/janus-api/info")"
[[ "$INFO_CODE" == "200" ]] && ok "시그널링 API 200 (127.0.0.1:${JANUS_HTTP_PORT})" \
    || warn "시그널링 API 가 ${INFO_CODE} 입니다 — systemctl status janus"
[[ -f "${SECRETS_DIR}/api-secret" ]] && ok "api-secret" \
    || warn "secrets/api-secret 이 없습니다 — sudo ./install.sh --apply"

echo
echo "SIP 계정 (${FROM_USER} → ${TO_USER})"
for u in "$FROM_USER" "$TO_USER"; do
    f="$(pw_file "$u")"
    if [[ -f "$f" ]]; then
        ok "${u}: secrets/sip-${u}.pw"
    else
        warn "${u}: secrets/sip-${u}.pw 가 없습니다"
        echo "         계정은 kamailio 대시보드에서 만들고, 비밀번호를 이 파일에 두세요:"
        echo "           umask 077; printf '%s' '<비밀번호>' > secrets/sip-${u}.pw"
        echo "         (계정을 사람이 정한다는 규약은 ../kamailio/accounts.md 를 보세요)"
    fi
done

echo
echo "포트"
if ss -ltn 2>/dev/null | grep -q "127.0.0.1:${HARNESS_PORT}\b"; then
    warn "${HARNESS_PORT} 이 이미 쓰이고 있습니다 — HARNESS_PORT 로 바꾸세요"
else
    ok "${HARNESS_PORT} 비어 있음 (하니스가 잠깐 쓴다)"
fi

echo
if [[ "$MODE" == "check" ]]; then
    if [[ $PROBLEMS -gt 0 ]]; then
        echo "점검: [!!] ${PROBLEMS}개. 위를 먼저 해결하세요."
        exit 1
    fi
    echo "점검: 문제 없음. 실제로 걸어 보려면 --run 을 붙이세요."
    exit 0
fi

[[ $PROBLEMS -gt 0 ]] && die "점검에서 [!!] ${PROBLEMS}개가 나왔습니다. --run 하지 않습니다."

# ── 실행 ────────────────────────────────────────────────────────────────
# 비밀번호가 argv 나 ps 에 남지 않도록 파일로만 옮긴다 (accounts.md 의 규약).
RUNDIR="$(mktemp -d)"
HARNESS_PID=""
CHROME_PID=""

cleanup() {
    [[ -n "$CHROME_PID" ]] && kill "$CHROME_PID" 2>/dev/null || true
    [[ -n "$HARNESS_PID" ]] && kill "$HARNESS_PID" 2>/dev/null || true
    rm -rf "$RUNDIR"
}
trap cleanup EXIT

umask 077
node -e '
const fs = require("fs"), path = require("path");
const [rundir, secrets, domain, proxy, from, to] = process.argv.slice(1);
const read = (f) => fs.readFileSync(f, "utf8").trim();
fs.writeFileSync(path.join(rundir, "accounts.json"), JSON.stringify({
  apiSecret: read(path.join(secrets, "api-secret")),
  sipDomain: domain,
  sipProxy: proxy,
  accounts: {
    a: { user: from, secret: read(path.join(secrets, `sip-${from}.pw`)) },
    b: { user: to,   secret: read(path.join(secrets, `sip-${to}.pw`)) },
  },
}));
' "$RUNDIR" "$SECRETS_DIR" "$SIP_DOMAIN" "$SIP_PROXY" "$FROM_USER" "$TO_USER"

mkdir -p "$OUTDIR"
rm -f "${OUTDIR}/result.json"

echo "하니스를 띄웁니다 (127.0.0.1:${HARNESS_PORT})"
HARNESS_PORT="$HARNESS_PORT" HARNESS_RUNDIR="$RUNDIR" HARNESS_OUTDIR="$OUTDIR" \
JANUS_HTTP_PORT="$JANUS_HTTP_PORT" JANUS_JS_PATH="$JANUS_JS_SRC" \
    node "${HARNESS_DIR}/serve.js" > "${OUTDIR}/harness.log" 2>&1 &
HARNESS_PID=$!

for _ in $(seq 1 20); do
    [[ "$(probe_http "http://127.0.0.1:${HARNESS_PORT}/")" == "200" ]] && break
    sleep 0.5
done
[[ "$(probe_http "http://127.0.0.1:${HARNESS_PORT}/")" == "200" ]] \
    || { cat "${OUTDIR}/harness.log"; die "하니스가 뜨지 않았습니다"; }

echo "헤드리스 크롬으로 ${FROM_USER} → ${TO_USER} 통화를 겁니다…"
# 프로필은 매번 새로 만든다 — 남은 권한 상태가 결과를 바꾸지 않게.
CHROME_PROFILE="${RUNDIR}/chrome-profile"
"$CHROME" \
    --headless=new \
    --disable-gpu \
    --no-first-run \
    --user-data-dir="$CHROME_PROFILE" \
    --use-fake-device-for-media-stream \
    --use-fake-ui-for-media-stream \
    --autoplay-policy=no-user-gesture-required \
    "http://127.0.0.1:${HARNESS_PORT}/" > "${OUTDIR}/chrome.log" 2>&1 &
CHROME_PID=$!

# 판정은 하니스의 종료 코드가 들고 온다 (0 통과 · 1 실패 · 2 무응답).
set +e
wait "$HARNESS_PID"
VERDICT=$?
set -e
HARNESS_PID=""

kill "$CHROME_PID" 2>/dev/null || true
CHROME_PID=""

echo
if [[ -f "${OUTDIR}/result.json" ]]; then
    node -e '
    const d = require(process.argv[1]);
    for (const [k, v] of Object.entries(d.steps || {})) console.log(`  ${k}  →  ${v}`);
    if (d.error) console.log(`  중단: ${d.error}`);
    ' "${OUTDIR}/result.json"
fi
echo
echo "  자세한 내용: test-harness/last-run/{result.json,browser.log,harness.log}"
echo

case "$VERDICT" in
    0) echo "5단계: 통과" ;;
    2) echo "5단계: 판정 불가 — 브라우저가 결과를 보내지 않았습니다 (last-run/browser.log)" ;;
    *) echo "5단계: 실패" ;;
esac

# Janus 세션은 클라이언트가 사라진 뒤 session_timeout(기본 60초)이 지나야
# 회수된다. 끊자마자 Admin API 를 보면 남아 있는 것처럼 보이는데 누수가 아니다.
exit "$VERDICT"
