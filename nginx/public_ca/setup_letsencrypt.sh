#!/usr/bin/env bash
#
# Let's Encrypt 공인 인증서를 받아 nginx 에 물린다.
#
#   ./setup_letsencrypt.sh --check c-a3f19c04.rtc.zoomon.art
#   ./setup_letsencrypt.sh --staging c-a3f19c04.rtc.zoomon.art
#   ./setup_letsencrypt.sh --prod -m you@example.com c-a3f19c04.rtc.zoomon.art
#
# ── 왜 여기에 있나 ───────────────────────────────────────────────
# README 의 경계표에서 nginx/ 가 "TLS 설정과 인증서" 를 담기로 되어 있다.
# 이건 새 역할이 아니라 nginx 가 인증서를 얻는 방법이라 nginx/ 아래 둔다.
# 사설 CA 를 만드는 ../generate_certs.sh 의 짝이다 — 같은 자리를 채우는
# 두 가지 방법이고, 공인 인증서 쪽이 배포용이다.
#
# ── 인증서는 이 저장소에 없다 ────────────────────────────────────
# certbot 이 /etc/letsencrypt/ 에 두고 스스로 갱신한다. 여기 있는 것은
# 받아오는 절차와 점검뿐이다. 사설 CA(../cert/)처럼 파일을 들고 있지 않다.
#
# 자세한 설명은 README.md 를 보세요.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
STACK_CONF="${NGINX_DIR}/nginx-stack.conf"

MODE=""            # check | staging | prod
EMAIL=""
DOMAINS=()

usage() {
    cat <<'EOF'
사용법: ./setup_letsencrypt.sh <모드> [옵션] <도메인> [도메인...]

모드:
  --check              발급 전 점검만 한다. 아무것도 바꾸지 않는다
  --staging            시험 발급. 진짜 인증서가 아니고 rate limit 을 쓰지 않는다
  --prod               실제 발급. --staging 이 통과한 뒤에만 쓴다

옵션:
  -m, --email <주소>   만료 알림을 받을 주소 (--prod 에서 권장)
  -h, --help           도움말

예:
  ./setup_letsencrypt.sh --check   www.zoomon.art
  ./setup_letsencrypt.sh --staging www.zoomon.art
  ./setup_letsencrypt.sh --prod -m you@example.com c-a3f19c04.rtc.zoomon.art

순서: --check 로 막힌 데를 먼저 없애고, --staging 으로 전 과정을 확인한 뒤,
      --prod 로 받는다. staging 을 건너뛰면 rate limit(주 5건)에 걸려 일주일을
      기다리게 되는 수가 있다.
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)   usage ;;
        --check)     MODE="check";   shift ;;
        --staging)   MODE="staging"; shift ;;
        --prod)      MODE="prod";    shift ;;
        -m|--email)  shift; EMAIL="${1:-}"; shift ;;
        -*)          echo "모르는 옵션: $1" >&2; usage ;;
        *)           DOMAINS+=("$1"); shift ;;
    esac
done

[[ -z "$MODE" ]] && usage
[[ ${#DOMAINS[@]} -eq 0 ]] && { echo "도메인을 하나 이상 지정하세요." >&2; usage; }

# root 로 실행되면 그대로, 아니면 필요한 명령에만 sudo 를 붙인다.
# install_nginx_stack.sh 와 같은 규칙이다 — 파일 소유권이 root 로 넘어가지 않게.
run_root() {
    if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

ok()   { echo "  ✅ $*"; }
warn() { echo "  ⚠️  $*"; }
bad()  { echo "  ❌ $*"; }

# nginx-stack.conf 의 [tls] acme_webroot 를 읽는다.
# 생성기와 같은 값을 봐야 한다 — 여기서 딴 데를 보면 챌린지를 못 찾는다.
read_webroot() {
    python3 - "$STACK_CONF" <<'PY'
import configparser, sys
p = configparser.ConfigParser()
p.read(sys.argv[1], encoding="utf-8")
print((p.get("tls", "acme_webroot", fallback="") or "").strip())
PY
}

WEBROOT="$(read_webroot)"

# ──────────────────────────────────────────────────────────────
# 점검 — 실패하는 이유는 거의 다 이 넷 중 하나다
# ──────────────────────────────────────────────────────────────
preflight() {
    local failed=0

    echo "[1/4] 설정"
    if [[ -z "$WEBROOT" ]]; then
        bad "nginx-stack.conf 의 [tls] acme_webroot 가 비어 있습니다."
        echo "       HTTP-01 을 쓰려면 값이 있어야 합니다 (예: /var/www/certbot)."
        failed=1
    else
        ok "acme_webroot = ${WEBROOT}"
        if [[ -d "$WEBROOT" ]]; then
            ok "디렉토리 있음"
        else
            bad "디렉토리가 없습니다: ${WEBROOT}"
            echo "       sudo mkdir -p ${WEBROOT}/.well-known/acme-challenge"
            echo "       sudo chown -R root:www-data ${WEBROOT} && sudo chmod -R 755 ${WEBROOT}"
            failed=1
        fi
    fi

    echo "[2/4] certbot"
    if command -v certbot >/dev/null 2>&1; then
        ok "$(certbot --version 2>&1 | head -1)"
    else
        warn "설치되어 있지 않습니다 — 발급할 때 자동으로 설치합니다."
    fi

    echo "[3/4] DNS"
    local public_ip
    public_ip="$(curl -s --max-time 5 ifconfig.me 2>/dev/null || true)"
    if [[ -z "$public_ip" ]]; then
        warn "공인 IP 를 확인하지 못했습니다 — DNS 대조를 건너뜁니다."
    else
        echo "       이 서버의 공인 IP: ${public_ip}"
        for d in "${DOMAINS[@]}"; do
            local resolved
            resolved="$(dig +short A "$d" 2>/dev/null | tail -1)"
            if [[ -z "$resolved" ]]; then
                bad "${d} — A 레코드가 없습니다. 등록기관에서 ${public_ip} 로 만드세요."
                failed=1
            elif [[ "$resolved" == "$public_ip" ]]; then
                ok "${d} → ${resolved}"
            else
                bad "${d} → ${resolved} (이 서버가 아닙니다)"
                failed=1
            fi
        done
    fi

    echo "[4/4] 80 포트 챌린지 경로"
    if [[ -z "$WEBROOT" || ! -d "$WEBROOT" ]]; then
        warn "webroot 가 준비되지 않아 건너뜁니다."
    else
        local probe="_preflight_$$"
        local probe_dir="${WEBROOT}/.well-known/acme-challenge"
        run_root mkdir -p "$probe_dir"
        echo "$probe" | run_root tee "${probe_dir}/${probe}" >/dev/null
        for d in "${DOMAINS[@]}"; do
            local body
            body="$(curl -s --max-time 8 "http://${d}/.well-known/acme-challenge/${probe}" 2>/dev/null || true)"
            if [[ "$body" == "$probe" ]]; then
                ok "${d} — 평문 200 응답 확인"
            else
                bad "${d} — 챌린지를 받지 못했습니다."
                echo "       80 포트가 외부에 열려 있는지, nginx 설정이 반영됐는지 보세요:"
                echo "         sudo ${NGINX_DIR}/install_nginx_stack.sh --skip-install"
                echo "       301 이 돌아온다면 acme_webroot 예외가 아직 반영되지 않은 것입니다."
                failed=1
            fi
        done
        run_root rm -f "${probe_dir}/${probe}"
    fi

    return $failed
}

echo "대상 도메인: ${DOMAINS[*]}"
echo

if ! preflight; then
    echo
    echo "점검에서 막힌 곳이 있습니다. 위 안내대로 고친 뒤 다시 실행하세요."
    exit 1
fi

echo
if [[ "$MODE" == "check" ]]; then
    echo "점검만 했습니다. 아무것도 바꾸지 않았습니다."
    echo "다음: ./setup_letsencrypt.sh --staging ${DOMAINS[*]}"
    exit 0
fi

# ──────────────────────────────────────────────────────────────
# 발급
# ──────────────────────────────────────────────────────────────
if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot 을 설치합니다..."
    run_root apt-get update -qq
    run_root apt-get install -y certbot
fi

primary="${DOMAINS[0]}"

# staging 과 실제 인증서에 다른 이름을 준다.
#
# 같은 이름을 쓰면 --prod 로 넘어갈 때 certbot 이 같은 계보를 갱신하려 들어,
# 먼저 지우지 않으면 걸린다. 이름을 나누면 staging 이 남아 있어도 실제 발급이
# 그냥 되고, 무엇이 시험용인지도 이름만 보고 안다.
if [[ "$MODE" == "staging" ]]; then
    CERT_NAME="${primary}-staging"
else
    CERT_NAME="${primary}"
fi

args=(certonly --webroot -w "$WEBROOT" --non-interactive --agree-tos --cert-name "$CERT_NAME")
for d in "${DOMAINS[@]}"; do args+=(-d "$d"); done

if [[ -n "$EMAIL" ]]; then
    args+=(-m "$EMAIL")
else
    # 메일 주소가 없으면 만료 알림을 받지 못한다. 자동 갱신이 조용히 멈춘 것을
    # 인증서가 만료된 뒤에야 알게 되므로, 배포용에서는 반드시 넣는 게 좋다.
    args+=(--register-unsafely-without-email)
    [[ "$MODE" == "prod" ]] && warn "메일 주소가 없습니다. 만료 알림을 받지 못합니다 (-m 권장)."
fi

# 갱신될 때마다 nginx 가 새 인증서를 읽게 한다. 이게 없으면 certbot 이 조용히
# 갱신해 두어도 nginx 는 만료된 것을 계속 내민다.
args+=(--deploy-hook "systemctl reload nginx")

if [[ "$MODE" == "staging" ]]; then
    args+=(--staging)
    echo "시험 발급합니다 (--staging). 진짜 인증서가 아닙니다."
else
    echo "실제 발급합니다."
fi

echo
run_root certbot "${args[@]}"

echo
live="/etc/letsencrypt/live/${CERT_NAME}"

if [[ "$MODE" == "staging" ]]; then
    cat <<EOF
시험 발급이 끝났습니다. 여기까지 왔으면 실제 발급도 통과합니다.

  다음: ./setup_letsencrypt.sh --prod -m <메일주소> ${DOMAINS[*]}

staging 인증서는 브라우저가 믿지 않으므로 nginx 에 물리지 마세요.
이름이 달라서(${CERT_NAME}) 그냥 두어도 실제 발급에 걸리지 않습니다.
지우려면: sudo certbot delete --cert-name ${CERT_NAME}
EOF
else
    cat <<EOF
발급됐습니다. nginx 에 물리려면 nginx-stack.conf 의 [tls] 를 바꾸세요:

  cert_file = ${live}/fullchain.pem
  key_file  = ${live}/privkey.pem

  ※ cert.pem 이 아니라 fullchain.pem 입니다. 중간 인증서가 빠지면
     일부 안드로이드 기기에서만 실패하는, 찾기 어려운 버그가 납니다.

그리고 반영합니다:

  sudo ${NGINX_DIR}/install_nginx_stack.sh --skip-install

확인:

  ${SCRIPT_DIR}/cert-status.sh
EOF
fi
