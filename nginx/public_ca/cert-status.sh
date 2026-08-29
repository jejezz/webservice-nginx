#!/usr/bin/env bash
#
# 지금 nginx 가 **실제로 내밀고 있는** 인증서를 확인한다.
#
#   ./cert-status.sh              사람이 읽는 형식
#   ./cert-status.sh --json       manager 대시보드용
#
# ── 왜 파일을 읽지 않고 접속해서 보나 ────────────────────────────
# 두 가지 이유가 있다.
#
# 1. /etc/letsencrypt/live/ 는 0700 root 라 일반 사용자가 읽지 못한다.
#    대시보드(manager)는 sudo 없이 도는 서비스이므로 파일로는 볼 수 없다.
#    services/manager/.../nginx.js 가 systemctl 을 읽기 전용으로만 쓰는 것과
#    같은 이유다.
#
# 2. 파일이 최신이어도 nginx 가 아직 reload 하지 않았으면 옛 인증서를 내민다.
#    "무엇이 디스크에 있나" 보다 "무엇이 나가고 있나" 가 우리가 알고 싶은 것이다.
#    deploy-hook 이 빠져서 갱신이 반영 안 되는 사고가 정확히 이 차이로 드러난다.
#
# 그래서 로컬 TLS 포트에 붙어 제시되는 인증서를 그대로 읽는다.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_CONF="$(cd "${SCRIPT_DIR}/.." && pwd)/nginx-stack.conf"

JSON=0
[[ "${1:-}" == "--json" ]] && JSON=1

# 접속할 포트와 SNI 이름을 설정에서 가져온다.
read_conf() {
    python3 - "$STACK_CONF" <<'PY'
import configparser, sys
p = configparser.ConfigParser()
p.read(sys.argv[1], encoding="utf-8")
g = lambda s, k, d: (p.get(s, k, fallback=d) or d).strip()
print(g("general", "ssl_port", "443"))
print(g("general", "server_name", "localhost"))
PY
}

mapfile -t _conf < <(read_conf)
SSL_PORT="${_conf[0]:-443}"
SERVER_NAME="${_conf[1]:-localhost}"

# 제시되는 인증서를 그대로 받아온다. 검증은 하지 않는다 — 사설 CA 든
# staging 이든 만료됐든, 지금 무엇이 나가고 있는지가 알고 싶은 것이다.
PEM="$(echo | openssl s_client -connect "127.0.0.1:${SSL_PORT}" \
        -servername "$SERVER_NAME" 2>/dev/null \
        | openssl x509 2>/dev/null || true)"

if [[ -z "$PEM" ]]; then
    if [[ $JSON -eq 1 ]]; then
        echo '{"ok":false,"error":"tls_unreachable"}'
    else
        echo "❌ 127.0.0.1:${SSL_PORT} 에서 인증서를 받지 못했습니다."
        echo "   nginx 가 떠 있는지 확인하세요: systemctl is-active nginx"
    fi
    exit 1
fi

field() { echo "$PEM" | openssl x509 -noout "$@" 2>/dev/null | cut -d= -f2- | sed 's/^ *//'; }

SUBJECT="$(field -subject)"
ISSUER="$(field -issuer)"
NOT_AFTER="$(field -enddate)"
SANS="$(echo "$PEM" | openssl x509 -noout -ext subjectAltName 2>/dev/null \
        | tail -n +2 | tr -d ' ' | sed 's/^ *//' || true)"

EXPIRY_EPOCH="$(date -d "$NOT_AFTER" +%s 2>/dev/null || echo 0)"
NOW="$(date +%s)"
DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW) / 86400 ))

# 발급자로 종류를 가른다. staging 인증서를 배포에 물려 두는 사고가
# 실제로 잦은데, 브라우저 오류를 보기 전까지는 눈치채기 어렵다.
KIND="unknown"
case "$ISSUER" in
    *"(STAGING)"*|*"Fake LE"*)  KIND="letsencrypt-staging" ;;
    *"Let's Encrypt"*|*"R3"*|*"E1"*|*"E5"*|*"R10"*|*"R11"*) KIND="letsencrypt" ;;
    *DevCA*)                    KIND="private-ca" ;;
esac

# 갱신 타이머. certbot 이 설치되어 있으면 자기 타이머를 함께 깐다.
TIMER="absent"
if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
    TIMER="$(systemctl is-active certbot.timer 2>/dev/null || echo inactive)"
fi

STATUS="ok"
(( DAYS_LEFT < 30 )) && STATUS="warn"
(( DAYS_LEFT < 7 ))  && STATUS="critical"
[[ "$KIND" == "letsencrypt-staging" ]] && STATUS="critical"
# 사설 CA 는 "도는" 상태이지 "끝난" 상태가 아니다. 공인 인증서로 옮기기 전까지
# 대시보드에 계속 걸려 있게 두어, 이관이 안 끝났다는 사실이 잊히지 않게 한다.
[[ "$KIND" == "private-ca" ]] && STATUS="warn"
[[ "$KIND" == "letsencrypt" && "$TIMER" != "active" ]] && STATUS="warn"

if [[ $JSON -eq 1 ]]; then
    python3 - <<PY
import json
print(json.dumps({
    "ok": True,
    "status": "${STATUS}",
    "kind": "${KIND}",
    "subject": """${SUBJECT}""",
    "issuer": """${ISSUER}""",
    "sans": """${SANS}""",
    "notAfter": "${NOT_AFTER}",
    "daysLeft": ${DAYS_LEFT},
    "renewTimer": "${TIMER}",
}, ensure_ascii=False))
PY
    exit 0
fi

icon="✅"; [[ "$STATUS" == "warn" ]] && icon="⚠️ "; [[ "$STATUS" == "critical" ]] && icon="❌"

echo "${icon} 지금 내밀고 있는 인증서  (127.0.0.1:${SSL_PORT})"
echo
echo "  주체    ${SUBJECT}"
echo "  발급자  ${ISSUER}"
[[ -n "$SANS" ]] && echo "  SAN     ${SANS}"
echo "  만료    ${NOT_AFTER}  (${DAYS_LEFT}일 남음)"
echo "  종류    ${KIND}"
echo "  갱신    certbot.timer — ${TIMER}"
echo

case "$KIND" in
    letsencrypt-staging)
        echo "  ❌ staging 인증서가 물려 있습니다. 브라우저와 앱이 거부합니다."
        echo "     실제 발급으로 바꾸세요: ./setup_letsencrypt.sh --prod -m <메일> <도메인>"
        ;;
    private-ca)
        echo "  ⚠️  사설 CA 인증서입니다. 앱이 CA 를 미리 심어야만 접속됩니다."
        echo "     공인 인증서로 옮기려면 README.md 를 보세요."
        ;;
    letsencrypt)
        if [[ "$TIMER" != "active" ]]; then
            echo "  ⚠️  자동 갱신 타이머가 꺼져 있습니다. 90일 뒤 조용히 만료됩니다."
            echo "     sudo systemctl enable --now certbot.timer"
        fi
        ;;
esac

(( DAYS_LEFT < 30 )) && echo "  ⚠️  만료가 가깝습니다. 갱신이 도는지 확인하세요."
exit 0
