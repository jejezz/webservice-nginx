#!/usr/bin/env bash
#
# 지금 nginx 가 **실제로 내밀고 있는** 인증서를 확인한다.
#
#   ./cert-status.sh              사람이 읽는 형식
#   ./cert-status.sh --json       manager 대시보드용
#   ./cert-status.sh --check      구축 마법사의 판정 (docs/check-contract.md)
#   ./cert-status.sh --check --json   같은 것을 기계가 읽는 형식으로
#
# --json 은 이미 대시보드 형식에 쓰이고 있어서, 점검 규약은 --check 로 가른다.
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
NGINX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${NGINX_DIR}/.." && pwd)"
STACK_CONF="${NGINX_DIR}/nginx-stack.conf"
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"

# 점검 규약 (docs/check-contract.md). --check 일 때만 쓴다.
source "${REPO_ROOT}/lib/check-report.sh"
check_init "public_ca.nginx"

JSON=0
CHECK=0
for a in "$@"; do
    case "$a" in
        --json)  JSON=1 ;;
        --check) CHECK=1 ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

# --check --json 은 점검 규약이지 대시보드 형식이 아니다.
if [[ $CHECK -eq 1 ]]; then
    CHECK_JSON=$JSON
    JSON=0
fi

# 절(section)은 쓰지 않는다 — node 쪽(lib/settings.js)도 같은 파일을 파싱한다.
settings_get() {
    local key="$1" v=""
    if [[ -r "$SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
    fi
    echo "${v//[[:space:]]/}"
}
WANT_DOMAIN="$(settings_get domain)"

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
    if [[ $CHECK -eq 1 ]]; then
        warn "127.0.0.1:${SSL_PORT} 에서 인증서를 받지 못했습니다 — nginx 가 떠 있는지 보세요 (systemctl is-active nginx)"
        check_finish
        exit 1
    fi
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

# ── 구축 마법사의 판정 (docs/check-contract.md) ─────────────────────────
#
# 이 단계가 묻는 것은 "발급받았나" 가 아니라 **"발급받은 것을 nginx 가 실제로
# 내밀고 있나"** 다. 둘은 다르다. 설정 파일을 바꿔 놓고 reload 를 잊으면 설정은
# 새것인데 나가는 것은 옛것이고, 그 상태는 파일만 봐서는 절대 보이지 않는다.
if [[ $CHECK -eq 1 ]]; then
    # ── nginx 설정이 무엇을 가리키는가 (설정 쪽) ────────────────────────
    #
    # ⚠️ **[tls] cert_file 을 직접 읽지 않는다. 그 값은 비어 있는 것이 정상이다.**
    #
    # 경로는 site/settings.ini 의 tls_mode 에서 파생한다 — 장비마다 다른
    # 절대경로가 커밋되는 nginx-stack.conf 에 박히지 않게 하려는 것이다.
    # 예전에는 사람이 그 줄을 손으로 적었고, 이 점검도 그때 만들어졌다.
    #
    # 그래서 비어 있는 것을 "cert_file 이 없습니다" 라고 말하고 있었다. 규약이
    # 하지 말라는 일을 하라고 시키는 셈이고, tls_mode 를 auto 로 둔 장비 —
    # 즉 기본 상태 — 에서는 이 단계가 영영 통과하지 못한다. 마법사의 이 단계
    # 설명이 "경로를 손으로 적을 필요는 없습니다" 라고 적고 있는데도 그랬다.
    #
    # 판정을 셸에 한 벌 더 적지도 않는다. 실제로 어느 인증서가 nginx 에
    # 들어가는지는 생성기가 정하므로 그쪽에 묻는다 (tls-decide.sh 와 같다).
    VERDICT="$(python3 "${NGINX_DIR}/generate_nginx_conf.py" --tls-mode 2>/dev/null || true)"
    jget() { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))" <<< "$VERDICT" 2>/dev/null || true; }

    MODE=""; REASON=""; CERT_FILE=""
    if [[ -n "$VERDICT" ]]; then
        MODE="$(jget mode)"
        REASON="$(jget reason)"
        CERT_FILE="$(jget cert)"
    fi

    configured=""
    if [[ -z "$CERT_FILE" ]]; then
        skip "어느 인증서로 갈렸는지 읽지 못했습니다 — python3 ../generate_nginx_conf.py --tls-mode 를 직접 돌려 보세요"
    else
        case "$CERT_FILE" in
            /etc/letsencrypt/live/*/fullchain.pem)
                configured="${CERT_FILE#/etc/letsencrypt/live/}"
                configured="${configured%%/*}"
                ok "nginx 설정이 ${configured} 의 fullchain.pem 을 가리킵니다 (${REASON})"
                ;;
            /etc/letsencrypt/live/*/cert.pem)
                # 브라우저는 멀쩡한데 일부 안드로이드 기기에서만 실패하는, 찾기 아주
                # 어려운 버그가 여기서 난다. 파생 경로는 늘 fullchain.pem 이므로,
                # 여기에 걸리는 것은 [tls] 에 직접 적은 경우뿐이다.
                configured="${CERT_FILE#/etc/letsencrypt/live/}"
                configured="${configured%%/*}"
                warn "[tls] cert_file 이 cert.pem 입니다 — 중간 인증서가 빠집니다. 그 두 줄을 비우면 fullchain.pem 으로 저절로 잡힙니다"
                ;;
            *)
                # 사설 CA 로 갈렸거나, [tls] 에 공인이 아닌 경로를 직접 적었다.
                if [[ "$MODE" == "declared" ]]; then
                    pend "[tls] 에 직접 적은 경로가 공인 인증서가 아닙니다 (${CERT_FILE}) — cert_file·key_file 두 줄을 비우면 tls_mode 에서 저절로 잡힙니다"
                else
                    pend "아직 공인 인증서로 갈리지 않았습니다 — ${REASON}"
                fi
                ;;
        esac
    fi

    # 지금 실제로 나가고 있는 것 (실물 쪽)
    case "$KIND" in
        letsencrypt)
            ok "지금 내밀고 있는 것: 공인 인증서 (${ISSUER})"
            ;;
        letsencrypt-staging)
            warn "지금 내밀고 있는 것이 시험(staging) 인증서입니다 — 브라우저와 앱이 거부합니다. sudo ./setup_letsencrypt.sh --prod 로 다시 받으세요"
            ;;
        private-ca)
            if [[ -n "$configured" ]]; then
                # 설정은 바꿨는데 아직 안 읽혔다. reload 를 잊은 자리다.
                pend "설정은 ${configured} 를 가리키는데 아직 사설 CA 를 내밀고 있습니다 — sudo ../install_nginx_stack.sh --skip-install 로 반영하세요"
            else
                pend "아직 사설 CA 인증서를 내밀고 있습니다 — 앱이 CA 를 미리 심어야만 접속됩니다"
            fi
            ;;
        *)
            skip "내밀고 있는 인증서의 종류를 가리지 못했습니다 (${ISSUER})"
            ;;
    esac

    # 앱이 접속하는 이름이 이 인증서에 들어 있는가. 없으면 TLS 는 붙는데 이름
    # 검증에서 떨어진다 — 앱에서는 그냥 "안 된다" 로만 보인다.
    if [[ -z "$WANT_DOMAIN" ]]; then
        skip "settings.ini 에 domain 이 없어 이름 대조를 건너뜁니다"
    elif [[ ",${SANS}," == *",DNS:${WANT_DOMAIN},"* ]]; then
        ok "${WANT_DOMAIN} 가 이 인증서의 SAN 에 있습니다"
    else
        warn "${WANT_DOMAIN} 가 내밀고 있는 인증서의 SAN 에 없습니다 (SAN: ${SANS:-없음})"
    fi

    info ""
    info "만료 ${NOT_AFTER} (${DAYS_LEFT}일 남음) — 갱신은 renew-status.sh 가 봅니다."

    check_finish
    [[ "$(check_state)" == "complete" ]] && exit 0 || exit 1
fi

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
        echo "     실제 발급으로 바꾸세요: sudo ./setup_letsencrypt.sh --prod"
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
