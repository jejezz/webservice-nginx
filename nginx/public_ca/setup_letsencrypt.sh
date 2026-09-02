#!/usr/bin/env bash
#
# Let's Encrypt 공인 인증서를 받아 nginx 에 물린다.
#
#   ./setup_letsencrypt.sh --check                점검만. 아무것도 바꾸지 않는다
#   ./setup_letsencrypt.sh --check --json         구축 마법사가 읽는 형식
#   ./setup_letsencrypt.sh --staging              시험 발급
#   ./setup_letsencrypt.sh --prod                 실제 발급
#
# 도메인과 메일 주소는 settings.ini 에서 읽는다 (docs/settings-contract.md).
# 구축 마법사의 폼이 그 파일을 쓰고, 사람이 직접 적어도 된다. 인자로 주면
# 그쪽이 이긴다:
#
#   ./setup_letsencrypt.sh --check c-a3f19c04.rtc.zoomon.art
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
# ── 점검은 sudo 없이 돈다 ────────────────────────────────────────
# 구축 마법사가 이 스크립트의 --check 를 직접 돌린다. 마법사는 sudo 를 부르지
# 않으므로 점검 경로에는 run_root 가 하나도 없어야 한다 (docs/setup-wizard.md
# 'sudo 경계'). 발급 경로에만 있다.
#
# 자세한 설명은 README.md 를 보세요.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${NGINX_DIR}/.." && pwd)"
STACK_CONF="${NGINX_DIR}/nginx-stack.conf"
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"
APPLIED_FILE="${SCRIPT_DIR}/.applied-settings"

# certbot 이 갱신 설정을 두는 곳. 0755 라 sudo 없이 읽힌다 — 그 옆의 live/ 와
# archive/ 는 0700 root 다. "발급됐는가" 를 권한 없이 알 수 있는 유일한 자리다.
RENEWAL_DIR="/etc/letsencrypt/renewal"

# 점검 규약 (docs/check-contract.md). ok/pend/skip/warn/info/judge 가 여기서 온다.
source "${REPO_ROOT}/lib/check-report.sh"
source "${REPO_ROOT}/lib/site.sh"
check_init "public_ca.issue"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

MODE=""            # check | staging | prod
EMAIL=""
DOMAINS=()

usage() {
    cat <<'EOF'
사용법: ./setup_letsencrypt.sh <모드> [옵션] [도메인...]

모드:
  --check              발급 전 점검만 한다. 아무것도 바꾸지 않는다
  --staging            시험 발급. 진짜 인증서가 아니고 rate limit 을 쓰지 않는다
  --prod               실제 발급. --staging 이 통과한 뒤에만 쓴다

옵션:
  --json               점검 결과를 기계가 읽는 형식으로 (docs/check-contract.md)
  -m, --email <주소>   만료 알림을 받을 주소 (--prod 에서 권장)
  -h, --help           도움말

도메인을 적지 않으면 settings.ini 의 domain 을 쓴다. 구축 마법사의 폼이 그
파일을 쓴다 (docs/settings-contract.md).

예:
  ./setup_letsencrypt.sh --check
  ./setup_letsencrypt.sh --staging
  sudo ./setup_letsencrypt.sh --prod
  ./setup_letsencrypt.sh --check c-a3f19c04.rtc.zoomon.art

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
        "")          shift ;;   # check_args 가 빈 배열을 넘길 때
        -*)          echo "모르는 옵션: $1" >&2; usage ;;
        *)           DOMAINS+=("$1"); shift ;;
    esac
done

# --json 만 주면 점검이라는 뜻이다. 마법사는 --check --json 을 주지만,
# 바꾸는 모드를 기계가 실수로 부르는 일이 없게 여기서도 못을 박는다.
[[ -z "$MODE" && $CHECK_JSON -eq 1 ]] && MODE="check"
[[ -z "$MODE" ]] && usage

# ──────────────────────────────────────────────────────────────
# 장비마다 다른 값 — settings.ini (docs/settings-contract.md)
# ──────────────────────────────────────────────────────────────

# 절(section)은 쓰지 않는다 — node 쪽(lib/settings.js)도 같은 파일을 파싱한다.
settings_get() {
    local file="$1" key="$2" fallback="${3:-}" v=""
    if [[ -r "$file" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$file" | tail -1)"
        v="${v%%[;#]*}"
    fi
    v="${v//[[:space:]]/}"
    echo "${v:-$fallback}"
}

# 도메인은 **사이트 값**이 기본이다 (site/README.md). 인증서·nginx server_name·
# 앱에게 알려 줄 주소가 같은 이름이어야 하는데, 각자 적게 두면 어긋나고 그
# 어긋남은 조용하다. 여기 settings.ini 에 적으면 그것이 이긴다.
if [[ ${#DOMAINS[@]} -eq 0 ]]; then
    from_settings="$(settings_get "$SETTINGS_FILE" domain "$(site_get host)")"
    [[ -n "$from_settings" ]] && DOMAINS+=("$from_settings")
fi
[[ -z "$EMAIL" ]] && EMAIL="$(settings_get "$SETTINGS_FILE" email)"

HAVE_DOMAIN=0
primary=""
if [[ ${#DOMAINS[@]} -gt 0 ]]; then
    HAVE_DOMAIN=1
    primary="${DOMAINS[0]}"
fi

# 발급을 하려면 도메인이 반드시 있어야 한다. 점검은 도메인 없이도 돌려야
# 한다 — 마법사가 "무엇을 채워야 하는지" 를 보여 주는 화면이기 때문이다.
if [[ $HAVE_DOMAIN -eq 0 && "$MODE" != "check" ]]; then
    echo "도메인이 없습니다. site/settings.ini 의 host 를 채우거나, 인자로 주거나, settings.ini 의 domain 에 적으세요." >&2
    usage
fi

# root 로 실행되면 그대로, 아니면 필요한 명령에만 sudo 를 붙인다.
# install_nginx_stack.sh 와 같은 규칙이다 — 파일 소유권이 root 로 넘어가지 않게.
# **점검 경로에서는 부르지 않는다.**
run_root() {
    if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

# nginx-stack.conf 의 [tls] 값을 읽는다.
# 생성기와 같은 값을 봐야 한다 — 여기서 딴 데를 보면 챌린지를 못 찾는다.
read_tls() {
    python3 - "$STACK_CONF" "$1" <<'PY' 2>/dev/null || true
import configparser, sys
p = configparser.ConfigParser(interpolation=None)
p.read(sys.argv[1], encoding="utf-8")
print((p.get("tls", sys.argv[2], fallback="") or "").strip())
PY
}

WEBROOT="$(read_tls acme_webroot)"

# ──────────────────────────────────────────────────────────────
# 점검
#
# 발급을 막는 것(preflight)과 발급이 됐는지 보는 것(report_issued)을 나눈다.
# 뒤엣것은 --staging/--prod 를 막으면 안 된다 — 아직 발급 안 된 것이 바로
# 지금 하려는 일이기 때문이다.
# ──────────────────────────────────────────────────────────────

BLOCKING=0
p_pend() { pend "$@"; BLOCKING=1; }
p_bad()  { warn "$@"; BLOCKING=1; }

# DNS 가 이 서버를 가리키지 않는 이름들. 80 포트 점검이 그 이름을 건너뛰는 데
# 쓴다 — 이름이 딴 데를 가리키면 챌린지도 당연히 못 오는데, 그것을 "공유기
# 포워딩을 보세요" 라고 말하면 엉뚱한 데를 뒤지게 만든다.
DNS_BAD=" "

check_config() {
    info "[1/4] 설정"
    if [[ $HAVE_DOMAIN -eq 0 ]]; then
        # 이미 물려 있는 것이 있으면 무엇을 적어야 하는지 같이 알려 준다.
        # [tls] cert_file 이 아니라 **생성기의 판정**을 본다. 그 줄은 비어 있는
        # 것이 정상이고, 경로는 site/settings.ini 의 tls_mode 에서 파생한다.
        local current
        current="$(python3 "${NGINX_DIR}/generate_nginx_conf.py" --tls-mode 2>/dev/null \
                   | python3 -c "import json,sys;print(json.load(sys.stdin).get('cert',''))" 2>/dev/null || true)"
        if [[ "$current" == /etc/letsencrypt/live/* ]]; then
            current="${current#/etc/letsencrypt/live/}"
            p_pend "발급받을 도메인이 정해지지 않았습니다 — settings.ini 의 domain (지금 nginx 설정은 ${current%%/*} 를 가리킵니다)"
        else
            p_pend "발급받을 도메인이 정해지지 않았습니다 — settings.ini 의 domain 에 적으세요"
        fi
    else
        ok "발급 대상: ${DOMAINS[*]}"
    fi

    if [[ -z "$WEBROOT" ]]; then
        p_pend "nginx-stack.conf 의 [tls] acme_webroot 가 비어 있습니다 — HTTP-01 을 쓰려면 값이 있어야 합니다 (예: /var/www/certbot)"
    elif [[ -d "$WEBROOT" ]]; then
        ok "acme_webroot = ${WEBROOT}"
    else
        p_pend "acme_webroot 디렉토리가 없습니다: ${WEBROOT} — sudo mkdir -p ${WEBROOT}/.well-known/acme-challenge && sudo chown -R root:www-data ${WEBROOT}"
    fi
}

check_certbot() {
    info "[2/4] certbot"
    if command -v certbot >/dev/null 2>&1; then
        ok "$(certbot --version 2>&1 | head -1)"
    else
        # 막지 않는다. 발급할 때 자동으로 깐다.
        pend "certbot 이 없습니다 — 발급할 때 자동으로 설치합니다"
    fi
}

check_dns() {
    info "[3/4] DNS"
    if [[ $HAVE_DOMAIN -eq 0 ]]; then
        skip "도메인이 없어 DNS 대조를 건너뜁니다"
        return
    fi

    local public_ip
    public_ip="$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ ! "$public_ip" =~ ^[0-9.]+$ ]]; then
        # 우리가 못 본 것이지 잘못된 것이 아니다 (docs/check-contract.md).
        skip "공인 IP 를 확인하지 못해 DNS 대조를 건너뜁니다"
        return
    fi

    info "       이 서버의 공인 IP: ${public_ip}"
    local d resolved
    for d in "${DOMAINS[@]}"; do
        resolved="$(dig +short A "$d" 2>/dev/null | tail -1)"
        if [[ -z "$resolved" ]]; then
            p_pend "${d} — A 레코드가 없습니다. 등록기관에서 ${public_ip} 로 만드세요"
            DNS_BAD+="${d} "
        elif [[ "$resolved" == "$public_ip" ]]; then
            ok "${d} → ${resolved}"
        else
            p_bad "${d} → ${resolved} (이 서버가 아닙니다. 지금은 ${public_ip} 입니다)"
            DNS_BAD+="${d} "
        fi
    done
}

# 80 포트가 챌린지 경로를 평문으로 받는가.
#
# 예전에는 webroot 에 파일을 하나 넣고 200 이 오는지 봤다. 그러려면 sudo 가
# 필요한데, 이 점검은 마법사가 sudo 없이 돌린다. 그래서 **없는 이름**을 부르고
# 404 가 오는지 본다 — 생성기가 만드는 예외 블록이 `try_files $uri =404` 라,
# 없는 이름의 정답이 404 다. 확인하려는 셋을 그대로 다 확인한다:
#
#   · 바깥에서 80 으로 들어온다        (연결이 됐다)
#   · 그 경로가 평문으로 응답한다      (301 로 넘어가지 않았다)
#   · 예외 location 이 살아 있다       (301 이 아니라 404 가 왔다)
#
# 예전 방식이 더 봤던 것은 "nginx 가 보는 webroot 와 certbot 이 쓸 webroot 가
# 같은가" 하나뿐인데, 둘 다 nginx-stack.conf 의 같은 값에서 나오므로 어긋날 수
# 없다. 어긋나는 경우(설치본이 낡음)는 아래 301 로 잡힌다.
check_challenge_path() {
    info "[4/4] 80 포트 챌린지 경로"
    if [[ $HAVE_DOMAIN -eq 0 ]]; then
        skip "도메인이 없어 건너뜁니다"
        return
    fi
    if [[ -z "$WEBROOT" ]]; then
        skip "acme_webroot 가 비어 있어 건너뜁니다"
        return
    fi

    local d code
    for d in "${DOMAINS[@]}"; do
        # 이름이 이 서버를 안 가리키면 여기서 무엇이 오든 위의 DNS 줄이 원인이다.
        if [[ "$DNS_BAD" == *" ${d} "* ]]; then
            skip "${d} — DNS 가 이 서버를 가리키지 않아 건너뜁니다 (위를 먼저 고치세요)"
            continue
        fi
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 \
                "http://${d}/.well-known/acme-challenge/probe-$$" 2>/dev/null || true)"
        case "$code" in
            404|200)
                ok "${d} — 80 포트가 챌린지 경로를 평문으로 받습니다 (HTTP ${code})" ;;
            30*)
                p_bad "${d} — 챌린지 경로가 HTTP ${code} 로 넘어갑니다. acme_webroot 예외가 아직 반영되지 않았습니다 (sudo ../install_nginx_stack.sh --skip-install)" ;;
            000|"")
                p_bad "${d} — 바깥에서 80 으로 들어오지 못했습니다. 공유기 포워딩을 보세요 (공유기가 내부에서 자기 주소로 도는 접속을 되꺾어 주지 않아도 이렇게 나옵니다)" ;;
            *)
                p_bad "${d} — 챌린지 경로가 HTTP ${code} 를 냅니다 (404 여야 합니다)" ;;
        esac
    done
}

preflight() {
    check_config
    check_certbot
    check_dns
    check_challenge_path
}

# 발급이 됐는가. 판정에만 넣고 발급을 막지는 않는다.
#
# live/ 는 0700 root 라 못 읽는다. renewal/<이름>.conf 는 0644 이고 발급의
# 결과로만 생기므로, 권한 없이 "발급됐다" 를 말할 수 있는 자리는 여기다.
report_issued() {
    info ""
    info "[발급] certbot 갱신 설정"

    if [[ $HAVE_DOMAIN -eq 0 ]]; then
        skip "도메인이 없어 발급 여부를 보지 않습니다"
        return
    fi

    if [[ ! -d "$RENEWAL_DIR" ]]; then
        pend "아직 발급받지 않았습니다 (${RENEWAL_DIR} 없음) — ./setup_letsencrypt.sh --staging 부터 하세요"
        return
    fi
    if [[ ! -r "$RENEWAL_DIR" || ! -x "$RENEWAL_DIR" ]]; then
        skip "${RENEWAL_DIR} 를 읽지 못해 발급 여부를 확인할 수 없습니다 (권한)"
        return
    fi

    local prod_conf="${RENEWAL_DIR}/${primary}.conf"
    local staging_conf="${RENEWAL_DIR}/${primary}-staging.conf"

    if [[ ! -r "$prod_conf" ]]; then
        if [[ -r "$staging_conf" ]]; then
            pend "시험 발급(staging)까지 됐습니다 — 이제 sudo ./setup_letsencrypt.sh --prod 로 실제 발급하세요"
        else
            pend "아직 발급받지 않았습니다 — ./setup_letsencrypt.sh --staging 부터 하세요"
        fi
        return
    fi

    # 이름은 실제 것인데 시험 서버에서 받아 온 경우. 브라우저도 앱도 거부한다.
    if grep -qi 'acme-staging' "$prod_conf"; then
        warn "${primary} 가 시험 서버(staging)에서 발급됐습니다 — 브라우저와 앱이 거부합니다. sudo certbot delete --cert-name ${primary} 뒤 --prod 로 다시 받으세요"
        return
    fi

    ok "발급됨 — ${prod_conf} (Let's Encrypt 운영 서버)"

    # 이 conf 가 정말 이 이름을 덮는가. SAN 조합을 바꿔 다시 받으면 여기가 갈린다.
    local d
    for d in "${DOMAINS[@]}"; do
        if grep -q "^${d}[[:space:]]*=" "$prod_conf" || grep -q "[/=[:space:]]${d}\$" "$prod_conf"; then
            ok "${d} 가 이 인증서에 들어 있습니다"
        else
            warn "${d} 가 ${prod_conf} 에 없습니다 — 다른 이름 조합으로 발급된 인증서입니다"
        fi
    done

    # 저장한 값과 실제로 발급한 값이 다른가 (docs/settings-contract.md).
    if [[ -r "$APPLIED_FILE" ]]; then
        local applied_email
        applied_email="$(settings_get "$APPLIED_FILE" email)"
        if [[ "$EMAIL" != "$applied_email" ]]; then
            pend "저장한 메일 주소가 아직 발급에 반영되지 않았습니다 (발급된 것: ${applied_email:-없음}) — sudo ./setup_letsencrypt.sh --prod"
        fi
    fi
}

info "대상 도메인: ${DOMAINS[*]:-(정해지지 않음)}"
info ""

preflight
[[ "$MODE" == "check" ]] && report_issued

# --json 이면 여기서 찍고 끝난다. 사람이 보는 모드면 아무것도 하지 않는다.
check_finish

if [[ $BLOCKING -eq 1 ]]; then
    echo
    echo "점검에서 막힌 곳이 있습니다. 위 [--] 와 [!!] 를 고친 뒤 다시 실행하세요."
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
    [[ "$MODE" == "prod" ]] && echo "  [!!]   메일 주소가 없습니다. 만료 알림을 받지 못합니다 (settings.ini 의 email 권장)."
fi

# 갱신될 때마다 nginx 가 새 인증서를 읽게 한다. 이게 없으면 certbot 이 조용히
# 갱신해 두어도 nginx 는 만료된 것을 계속 내민다. renew-status.sh 가 이 훅이
# 있는지를 따로 본다 — 없으면 90일 뒤에야 드러나기 때문이다.
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

  다음: sudo ./setup_letsencrypt.sh --prod

staging 인증서는 브라우저가 믿지 않으므로 nginx 에 물리지 마세요.
이름이 달라서(${CERT_NAME}) 그냥 두어도 실제 발급에 걸리지 않습니다.
지우려면: sudo certbot delete --cert-name ${CERT_NAME}
EOF
    exit 0
fi

# 실제로 발급한 값을 남긴다 (docs/settings-contract.md). **성공한 뒤에만**
# 남긴다 — 실패했는데 남기면 설치돼 있는 것과 기록이 어긋난다.
{
    echo "; setup_letsencrypt.sh --prod 가 마지막으로 발급한 값. 손으로 고치지 마세요."
    echo "domain = ${primary}"
    echo "email = ${EMAIL}"
} > "$APPLIED_FILE"
chmod 644 "$APPLIED_FILE"

cat <<EOF
발급됐습니다. **경로를 손으로 적을 필요는 없습니다.**

site/settings.ini 의 tls_mode 가 auto(기본)면, 생성기가 방금 발급된 것을 보고
${live}/fullchain.pem 으로 저절로 갈아탑니다. 장비마다 다른 절대경로를 커밋되는
nginx-stack.conf 에 적지 않으려고 그렇게 되어 있습니다. cert.pem 이 아니라
fullchain.pem 인 것도 생성기가 정합니다 — 중간 인증서가 빠지면 일부 안드로이드
기기에서만 실패하는, 찾기 어려운 버그가 납니다.

어느 쪽으로 갈렸는지 먼저 봅니다:

  python3 ../generate_nginx_conf.py --tls-mode

남은 것은 반영뿐입니다:

  sudo ../install_nginx_stack.sh --skip-install

확인:

  ${SCRIPT_DIR}/cert-status.sh --check
  ${SCRIPT_DIR}/renew-status.sh --check
EOF
