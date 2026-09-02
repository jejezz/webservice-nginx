#!/usr/bin/env bash
#
# 서버 인증서를 **공인으로 갈지 사설로 갈지** 정하고, 그 근거를 보여 준다.
#
#   ./tls-decide.sh                 사람이 읽는 형식
#   ./tls-decide.sh --check --json  구축 마법사용 (docs/check-contract.md)
#
# ── 왜 단계가 하나 더 있나 ───────────────────────────────────────
# 이 갈림길이 지금까지 **아무 데도 없었다.** nginx 는 어느 쪽이든 멀쩡히 뜨고,
# 브라우저만 사설 CA 에 경고를 낸다. 그래서 사설로 떨어진 것을 **앱이 안
# 붙는다는 신고가 올 때까지 아무도 모른다.**
#
# 여기서 한 번 소리 내어 정하고 지나간다. 사설이 잘못된 것은 아니다 — LAN
# 전용 배치에서는 그쪽이 옳다. 잘못된 것은 **모르고 지나가는 것**이다.
#
# ── 판정을 여기서 다시 구현하지 않는다 ───────────────────────────
# 실제로 어느 인증서가 nginx 에 들어가는지는 generate_nginx_conf.py 가 정한다.
# 그 규칙을 셸에 한 벌 더 적으면 언젠가 갈라지고, **갈라진 것을 알아차릴 방법이
# 없다.** 그래서 그쪽에 `--tls-mode` 로 물어본다.
#
# 이 스크립트가 더하는 것은 "그래서 공인으로 갈 수 있는 장비인가" 다.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${REPO_ROOT}/lib/check-report.sh"
source "${REPO_ROOT}/lib/site.sh"

check_init "tls.decide"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

for a in "$@"; do
    case "$a" in
        --check|"") ;;
        -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

# ── 1. 무엇으로 갈렸나 ──────────────────────────────────────────
info "서버 인증서 — 어느 쪽으로 갈리나"

VERDICT="$(python3 "${SCRIPT_DIR}/generate_nginx_conf.py" --tls-mode 2>/dev/null || true)"
if [[ -z "$VERDICT" ]]; then
    warn "판정을 읽지 못했습니다 — python3 ./generate_nginx_conf.py --tls-mode 를 직접 돌려 보세요"
    check_finish
    exit 1
fi

jget() { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))" <<< "$VERDICT"; }

MODE="$(jget mode)"
REASON="$(jget reason)"
HOST="$(jget host)"
CERT="$(jget cert)"
HALF="$(jget halfDeclared)"

[[ "$HALF" == "True" ]] && warn "[tls] cert_file 과 key_file 중 하나만 적혀 있습니다 — 둘 다 적거나 둘 다 비우세요"

case "$MODE" in
    declared) ok "직접 지정: ${CERT}"; info "  (${REASON})" ;;
    public)   ok "공인 인증서로 갑니다 — ${REASON}" ;;
    private)  skip "사설 CA 로 갑니다 — ${REASON}" ;;
    *)        warn "알 수 없는 판정: ${MODE}" ;;
esac

# ── 2. 그래서 공인으로 갈 수 있는 장비인가 ──────────────────────
#
# 사설로 갈린 장비에서만 따진다. 이미 공인이면 답이 나온 것이다.
#
# ⚠️ **바깥에서 80 이 닿는가는 여기서 판정할 수 없다.** 그 확인은 없는 이름을
#    부르고 404 가 오는지 보는 것인데, 그 404 를 내는 예외 블록(acme_webroot)이
#    nginx.routes 에서야 반영된다. 이 단계는 그보다 앞이다. 그래서 여기서는
#    건너뛰고, public_ca.issue 의 점검이 그 자리를 맡는다.
#
# 여기의 판정은 **전부 skip 이다.** 공인으로 갈 수 없는 것은 잘못이 아니라
# 사실이고, LAN 전용 배치에서는 사설이 옳은 선택이다. pending 으로 두면 그런
# 장비의 마법사가 영영 끝나지 않는다 (docs/check-contract.md 의 skip/pending).
# 막지 않고 **보여 주기만** 한다.
if [[ "$MODE" == "private" ]]; then
    info ""
    info "공인 인증서를 받을 수 있는 장비인가 (막지 않습니다 — 참고용)"

    # (1) 소유한 이름인가
    if [[ -z "$HOST" || "$HOST" == "localhost" ]]; then
        skip "공개 호스트 이름이 없습니다 — site/settings.ini 의 host 를 채우세요"
    elif [[ "$HOST" != *.* ]]; then
        skip "${HOST} — 점이 없는 이름으로는 공인 인증서를 받을 수 없습니다"
    elif [[ "$HOST" =~ \.(local|localdomain|internal|lan|home|test|invalid|example)$ ]]; then
        skip "${HOST} — 예약된 이름이라 공인 인증서를 받을 수 없습니다"
    elif [[ "$HOST" =~ \.(iptime\.org|ddns\.net|no-ip\.org|duckdns\.org)$ ]]; then
        skip "${HOST} — DDNS 이름입니다. 그 존에 레코드를 만들 권한이 없어 발급받을 수 없습니다"
    else
        ok "${HOST} — 발급받을 수 있는 형태의 이름입니다"

        # (2) A 레코드가 이 서버인가
        public_ip="$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null | tr -d '[:space:]' || true)"
        if [[ ! "$public_ip" =~ ^[0-9.]+$ ]]; then
            skip "공인 IP 를 확인하지 못해 A 레코드 대조를 건너뜁니다"
        elif ! command -v dig >/dev/null 2>&1; then
            skip "dig 가 없어 A 레코드 대조를 건너뜁니다 (sudo apt install -y dnsutils)"
        else
            resolved="$(dig +short A "$HOST" 2>/dev/null | tail -1)"
            if [[ -z "$resolved" ]]; then
                skip "${HOST} — A 레코드가 없습니다. 등록기관에서 ${public_ip} 로 만드세요"
            elif [[ "$resolved" == "$public_ip" ]]; then
                ok "${HOST} → ${resolved} (이 서버입니다)"
            else
                skip "${HOST} → ${resolved} — 이 서버가 아닙니다 (지금 ${public_ip})"
            fi
        fi
    fi

    # (3) certbot
    if command -v certbot >/dev/null 2>&1; then
        ok "certbot: $(certbot --version 2>&1 | head -1)"
    elif apt-cache policy certbot 2>/dev/null | grep -q 'Candidate: [0-9]'; then
        ok "certbot 을 apt 로 설치할 수 있습니다 (발급할 때 자동으로 깝니다)"
    else
        skip "certbot 을 찾지 못했습니다 — apt 저장소를 확인하세요"
    fi

    # (4) 바깥에서 80
    skip "바깥에서 80 이 닿는지는 여기서 보지 않습니다 — 챌린지 예외가 nginx.routes 에서 반영된 뒤에야 확인됩니다 (public_ca.issue 가 봅니다)"
fi

# ── 3. 사설로 간다면 인증서가 실제로 있는가 ─────────────────────
if [[ "$MODE" == "private" ]]; then
    info ""
    if [[ -f "$CERT" ]]; then
        ok "사설 인증서가 있습니다: ${CERT}"
    else
        pend "사설 인증서가 아직 없습니다 → ./generate_certs.sh --auto ${HOST}"
    fi
fi

check_finish

echo
if [[ "$MODE" == "private" ]]; then
    cat <<EOF
사설 CA 로 가는 것은 **오류가 아닙니다.** LAN 전용 배치에서는 그쪽이 옳습니다.
다만 잊히지 않게 대시보드의 TLS 카드에 계속 남습니다.

공인으로 옮기려면 — site/settings.ini 의 host 를 채우고 A 레코드를 이 서버로
맞춘 뒤, 마법사의 '공인 인증서 발급' 단계로 갑니다. tls_mode 는 auto 로 두면
발급이 끝나는 순간 저절로 public 이 됩니다.

앱이 스토어로 배포되는 배치라면 사설 CA 는 선택지가 아닙니다 — 앱이 그 CA 를
믿게 만들 방법이 사실상 없습니다. docs/unify-plan.md 의 'TLS' 절을 보세요.
EOF
fi
