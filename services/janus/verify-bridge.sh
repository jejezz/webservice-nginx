#!/usr/bin/env bash
#
# 계획서 6단계 — 브라우저(WebRTC) ↔ 평문 RTP 단말 브리징을 사람 없이 확인한다.
#
#   ./verify-bridge.sh                점검만 (아무 전화도 걸지 않는다)
#   ./verify-bridge.sh --run          양방향 (발신 · 착신) 다 시험
#   ./verify-bridge.sh --run --out    브라우저 → 평문 단말 (6-2) 만
#   ./verify-bridge.sh --run --in     평문 단말 → 브라우저 (6-3) 만
#
# 5단계(verify-call.sh)와 무엇이 다른가 — **상대가 WebRTC 가 아니다.**
#
# 5단계는 양쪽이 다 크롬이라 opus 로 붙는다. 그래서 Janus 가 WebRTC 를 평문
# RTP 로 바꾸는 부분도, ⑥이 말한 PCMU/PCMA 교집합도 한 번도 시험되지 않는다.
# 여기서는 상대를 **G.711 만 하는 평문 SIP 단말**(test-harness/sipua.js)로 두어
# 그 두 가지를 처음으로 재게 한다.
#
# 무엇을 단언하는가:
#
#   6-2  브라우저 → 평문 단말 : 협상 코덱이 PCMU/PCMA 인가, RTP 가 양방향인가
#   6-3  평문 단말 → 브라우저 : 방향이 바뀌어도 같은가 (SDP 협상 순서가 다르다)
#   6-4  SDP 의 c= 가 192.168.0.252 인가 (③의 local_ip 결정)
#
# **코덱이 opus 로 나오면 실패다.** Janus 는 트랜스코딩하지 않으므로, opus 로
# 붙었다는 것은 평문 단말까지 도달하지 못했다는 뜻이다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="${SCRIPT_DIR}/test-harness"
SECRETS_DIR="${SCRIPT_DIR}/secrets"
OUTDIR="${HARNESS_DIR}/last-run-bridge"

JANUS_JS_SRC="${JANUS_JS_PATH:-/opt/janus/share/janus/javascript/janus.js}"
ADAPTER_JS_SRC="${SCRIPT_DIR}/web/node_modules/webrtc-adapter/out/adapter.js"
JANUS_HTTP_PORT="${JANUS_HTTP_PORT:-8088}"
HARNESS_PORT="${HARNESS_PORT:-28201}"

SIP_DOMAIN="${SIP_DOMAIN:-pluto.org}"
SIP_PROXY="${SIP_PROXY:-sip:192.168.0.252:5060}"
# 평문 단말이 자기 SDP 에 실을 주소. Janus 의 local_ip 와 같아야 한다 (③).
LOCAL_IP="${LOCAL_IP:-192.168.0.252}"
UA_SIP_PORT="${UA_SIP_PORT:-45060}"
UA_RTP_PORT="${UA_RTP_PORT:-40100}"

MODE="check"
BROWSER_USER="2001"
UA_USER="2004"
DO_OUT=1
DO_IN=1
TALK="${TALK:-10}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --run)   MODE="run"; shift ;;
        --check) MODE="check"; shift ;;
        --out)   DO_IN=0; shift ;;
        --in)    DO_OUT=0; shift ;;
        --browser) BROWSER_USER="${2:?}"; shift 2 ;;
        --phone)   UA_USER="${2:?}"; shift 2 ;;
        -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

ok()   { echo "  [ok]   $*"; }
warn() { echo "  [!!]   $*"; PROBLEMS=$((PROBLEMS + 1)); }
die()  { echo "오류: $*" >&2; exit 1; }
PROBLEMS=0

probe_http() {
    local out
    out="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)" || true
    echo "${out:-000}"
}
find_chrome() {
    local c
    for c in google-chrome chromium chromium-browser; do
        command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
    done
    return 1
}

# ── 점검 ────────────────────────────────────────────────────────────────
echo "도구"
command -v node >/dev/null && ok "node $(node --version)" || warn "node 가 없습니다"
if CHROME="$(find_chrome)"; then ok "브라우저 ${CHROME}"; else CHROME=""; warn "크롬이 없습니다"; fi

echo
echo "자원"
[[ -f "$JANUS_JS_SRC" ]] && ok "janus.js" || warn "janus.js 없음: ${JANUS_JS_SRC}"
[[ -f "$ADAPTER_JS_SRC" ]] && ok "webrtc-adapter" || warn "webrtc-adapter 없음 — ./setup-dashboard.sh --build"
[[ -f "${HARNESS_DIR}/sipua.js" ]] && ok "평문 SIP 단말 (test-harness/sipua.js)" || warn "sipua.js 가 없습니다"

echo
echo "Janus"
[[ "$(probe_http "http://127.0.0.1:${JANUS_HTTP_PORT}/janus-api/info")" == "200" ]] \
    && ok "시그널링 API 200" || warn "시그널링 API 응답 없음 — systemctl status janus"
[[ -f "${SECRETS_DIR}/api-secret" ]] && ok "api-secret" || warn "secrets/api-secret 없음"

echo
echo "SIP 계정 (브라우저 ${BROWSER_USER} · 평문 단말 ${UA_USER})"
for u in "$BROWSER_USER" "$UA_USER"; do
    if [[ -f "${SECRETS_DIR}/sip-${u}.pw" ]]; then ok "${u}: secrets/sip-${u}.pw"
    else
        warn "${u}: secrets/sip-${u}.pw 가 없습니다"
        echo "         umask 077; printf '%s' '<비밀번호>' > secrets/sip-${u}.pw"
    fi
done

echo
echo "포트"
for p in "$HARNESS_PORT" "$UA_SIP_PORT" "$UA_RTP_PORT"; do
    if ss -lun 2>/dev/null | grep -q ":${p}\b" || ss -ltn 2>/dev/null | grep -q ":${p}\b"; then
        warn "${p} 이 이미 쓰이고 있습니다"
    else
        ok "${p} 비어 있음"
    fi
done

echo
if [[ "$MODE" == "check" ]]; then
    [[ $PROBLEMS -gt 0 ]] && { echo "점검: [!!] ${PROBLEMS}개."; exit 1; }
    echo "점검: 문제 없음. 실제로 걸어 보려면 --run 을 붙이세요."
    exit 0
fi
[[ $PROBLEMS -gt 0 ]] && die "점검에서 [!!] ${PROBLEMS}개가 나왔습니다."

# ── 실행 ────────────────────────────────────────────────────────────────
RUNDIR="$(mktemp -d)"
CHILDREN=()
cleanup() {
    for p in "${CHILDREN[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
    rm -rf "$RUNDIR"
}
trap cleanup EXIT

mkdir -p "$OUTDIR"
umask 077

write_config() {  # $1 = 상대 사용자명 (발신 방향에서만 쓰인다)
    node -e '
    const fs = require("fs"), path = require("path");
    const [rundir, secrets, domain, proxy, browser, peer] = process.argv.slice(1);
    const read = (f) => fs.readFileSync(f, "utf8").trim();
    fs.writeFileSync(path.join(rundir, "accounts.json"), JSON.stringify({
      apiSecret: read(path.join(secrets, "api-secret")),
      sipDomain: domain, sipProxy: proxy, peer,
      accounts: { a: { user: browser, secret: read(path.join(secrets, `sip-${browser}.pw`)) } },
    }));
    ' "$RUNDIR" "$SECRETS_DIR" "$SIP_DOMAIN" "$SIP_PROXY" "$BROWSER_USER" "$1"
}

start_harness() {  # $1 = 페이지
    HARNESS_PORT="$HARNESS_PORT" HARNESS_RUNDIR="$RUNDIR" HARNESS_OUTDIR="$OUTDIR" \
    HARNESS_PAGE="$1" ADAPTER_JS="$ADAPTER_JS_SRC" JANUS_JS_PATH="$JANUS_JS_SRC" \
    JANUS_HTTP_PORT="$JANUS_HTTP_PORT" \
        node "${HARNESS_DIR}/serve.js" > "${OUTDIR}/harness.log" 2>&1 &
    HARNESS_PID=$!
    CHILDREN+=("$HARNESS_PID")
    for _ in $(seq 1 20); do
        [[ "$(probe_http "http://127.0.0.1:${HARNESS_PORT}/")" == "200" ]] && return 0
        sleep 0.5
    done
    cat "${OUTDIR}/harness.log"; die "하니스가 뜨지 않았습니다"
}

start_chrome() {
    # 프로필은 매번 새로 만든다. 남은 SingletonLock 이 있으면 크롬이 아예 뜨지 않는다.
    "$CHROME" --headless=new --disable-gpu --no-first-run \
        --user-data-dir="${RUNDIR}/chrome-$1" \
        --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
        --autoplay-policy=no-user-gesture-required \
        "http://127.0.0.1:${HARNESS_PORT}/" > "${OUTDIR}/chrome.log" 2>&1 &
    CHROME_PID=$!
    CHILDREN+=("$CHROME_PID")
}

start_ua() {  # $1 = mode(answer|call), $2 = peer, $3 = 로그 접미사
    node "${HARNESS_DIR}/sipua.js" \
        --user "$UA_USER" --pw-file "${SECRETS_DIR}/sip-${UA_USER}.pw" \
        --domain "$SIP_DOMAIN" --proxy "${SIP_PROXY#sip:}" \
        --local-ip "$LOCAL_IP" --sip-port "$UA_SIP_PORT" --rtp-port "$UA_RTP_PORT" \
        --mode "$1" --peer "$2" --duration "$TALK" --wait 150 \
        > "${OUTDIR}/phone-$3.json" 2> "${OUTDIR}/phone-$3.log" &
    UA_PID=$!
    CHILDREN+=("$UA_PID")
}

report() {  # $1 = 제목, $2 = 브라우저 result.json, $3 = 단말 json
    echo
    echo "── $1 ────────────────────────────────────────────"
    node -e '
    const fs = require("fs");
    const [b, p] = process.argv.slice(1);
    const br = JSON.parse(fs.readFileSync(b, "utf8"));
    for (const [k, v] of Object.entries(br.steps || {})) console.log(`  ${k}  →  ${v}`);
    if (br.error) console.log(`  브라우저 중단: ${br.error}`);
    try {
      const ph = JSON.parse(fs.readFileSync(p, "utf8"));
      console.log(`  평문 단말  →  코덱 ${ph.codec}, 수신 ${ph.rtpPacketsIn} / 송신 ${ph.rtpPacketsOut}, `
        + `수신 payload type [${(ph.rtpInPayloadTypes || []).join(",")}]${ph.error ? " — " + ph.error : ""}`);
    } catch { console.log("  평문 단말  →  결과 없음"); }
    ' "$2" "$3"
}

VERDICT=0

# ── 6-2 브라우저 → 평문 단말 ────────────────────────────────────────────
if [[ $DO_OUT -eq 1 ]]; then
    echo "6-2  브라우저(${BROWSER_USER}) → 평문 단말(${UA_USER})"
    rm -f "${OUTDIR}/result.json" "${OUTDIR}/phone-out.json"
    write_config "$UA_USER"
    start_ua answer "$BROWSER_USER" out
    sleep 3
    start_harness test-bridge-out.html
    start_chrome out
    set +e; wait "$HARNESS_PID"; R=$?; set -e
    kill "$CHROME_PID" 2>/dev/null || true
    wait "$UA_PID" 2>/dev/null || true
    report "6-2 발신 방향" "${OUTDIR}/result.json" "${OUTDIR}/phone-out.json"
    [[ $R -ne 0 ]] && VERDICT=1
    mv -f "${OUTDIR}/result.json" "${OUTDIR}/result-out.json" 2>/dev/null || true
fi

# ── 6-3 평문 단말 → 브라우저 ────────────────────────────────────────────
if [[ $DO_IN -eq 1 ]]; then
    echo
    echo "6-3  평문 단말(${UA_USER}) → 브라우저(${BROWSER_USER})"
    rm -f "${OUTDIR}/result.json" "${OUTDIR}/phone-in.json"
    write_config "$UA_USER"
    start_harness test-bridge-in.html
    start_chrome in
    # 브라우저가 등록을 마친 뒤에 걸어야 한다 — 헤드리스 크롬은 뜨는 데 30초가 걸린다.
    echo "  브라우저 등록을 기다립니다…"
    for _ in $(seq 1 40); do
        grep -q "브라우저 등록됨" "${OUTDIR}/harness.log" 2>/dev/null && break
        sleep 2
    done
    grep -q "브라우저 등록됨" "${OUTDIR}/harness.log" 2>/dev/null \
        && echo "  등록 확인 — 이제 겁니다" || echo "  [!!] 등록 확인 못 했지만 계속합니다"
    start_ua call "$BROWSER_USER" in
    set +e; wait "$HARNESS_PID"; R=$?; set -e
    kill "$CHROME_PID" 2>/dev/null || true
    wait "$UA_PID" 2>/dev/null || true
    report "6-3 착신 방향" "${OUTDIR}/result.json" "${OUTDIR}/phone-in.json"
    [[ $R -ne 0 ]] && VERDICT=1
    mv -f "${OUTDIR}/result.json" "${OUTDIR}/result-in.json" 2>/dev/null || true
fi

echo
echo "  자세한 내용: test-harness/last-run-bridge/"
echo
[[ $VERDICT -eq 0 ]] && echo "6단계: 통과" || echo "6단계: 실패"
exit "$VERDICT"
