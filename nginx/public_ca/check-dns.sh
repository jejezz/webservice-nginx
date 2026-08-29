#!/usr/bin/env bash
#
# 공개 이름이 아직 이 서버를 가리키는지 본다.
#
#   ./check-dns.sh              사람이 읽는 형식
#   ./check-dns.sh --json       기계용 (docs/check-contract.md)
#   ./check-dns.sh --quiet      조용히. 크론용 — 어긋날 때만 종료 코드 1
#
# ── 왜 필요한가 ──────────────────────────────────────────────────
# 이 회선은 유동 IP 인데 A 레코드는 등록기관에 **고정값**으로 들어 있다.
# 예전에는 공유기의 DDNS 가 따라갔지만 그 이름은 삭제됐다. 지금은 IP 가 바뀌면
# 사람이 가비아에 들어가 고쳐야 한다.
#
# 고치기 전까지 일어나는 일:
#
#   · 앱이 디렉터리에서 받은 주소로 붙지 못한다      ← 즉시, 전면
#   · SIP·Janus 의 ICE 후보 주소가 틀어진다
#   · certbot 갱신이 실패한다                        ← 만료 30일 전부터 조용히
#
# 첫째가 즉시 터지므로 사람이 알아차리기는 한다. 문제는 **왜인지 모른다**는
# 것이다. 이 점검이 그 답을 한 줄로 준다.
#
# 크론 예:
#   */10 * * * * <경로>/check-dns.sh --quiet || echo "DNS 가 이 서버를 가리키지 않습니다" | logger -t dns-drift

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${REPO_ROOT}/lib/check-report.sh"

check_init "public_ca.dns"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

QUIET=0
NAMES=()
for a in "$@"; do
    case "$a" in
        --quiet) QUIET=1 ;;
        -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        "") ;;
        -*) echo "Unknown option: $a" >&2; exit 2 ;;
        *) NAMES+=("$a") ;;
    esac
done

say() { [[ $QUIET -eq 1 || $CHECK_JSON -eq 1 ]] || echo "$@"; }

# 이름을 안 주면 nginx 가 내밀고 있는 인증서에서 가져온다.
# 인증서에 든 이름이야말로 앱이 실제로 접속하는 이름이다.
if [[ ${#NAMES[@]} -eq 0 ]]; then
    ssl_port="$(sed -n 's/^[[:space:]]*ssl_port[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' \
                "${REPO_ROOT}/nginx/nginx-stack.conf" | tail -1)"
    ssl_port="${ssl_port:-443}"
    while IFS= read -r n; do
        [[ -n "$n" ]] && NAMES+=("$n")
    done < <(echo | openssl s_client -connect "127.0.0.1:${ssl_port}" 2>/dev/null \
             | openssl x509 -noout -ext subjectAltName 2>/dev/null \
             | tr ',' '\n' | sed -n 's/.*DNS://p' | tr -d ' ')
fi

if [[ ${#NAMES[@]} -eq 0 ]]; then
    judge skip "확인할 이름이 없습니다 (인증서에서 SAN 을 읽지 못했습니다)"
    check_finish
    exit 0
fi

# ── 지금의 공인 IP ──────────────────────────────────────────────────────
# 여기서는 외부 서비스에 묻는다. DNS 로는 알 수 없다 — DNS 가 맞는지를
# 보는 것이 이 점검의 목적이라, DNS 를 근거로 쓰면 아무것도 검사하지 못한다.
current=""
for svc in ifconfig.me api.ipify.org checkip.amazonaws.com; do
    current="$(curl -s --max-time 5 "https://${svc}" 2>/dev/null | tr -d '[:space:]')"
    [[ "$current" =~ ^[0-9.]+$ ]] && break
    current=""
done

if [[ -z "$current" ]]; then
    judge skip "공인 IP 를 확인하지 못했습니다 (바깥으로 나가지 못하는 상태)"
    check_finish
    [[ $QUIET -eq 1 ]] && exit 0
    echo "확인 불가: 공인 IP 를 알아내지 못했습니다" >&2
    exit 2
fi

say "현재 공인 IP   ${current}"
say ""

drift=0
for name in "${NAMES[@]}"; do
    resolved="$(dig +short A "$name" 2>/dev/null | tail -1)"
    if [[ -z "$resolved" ]]; then
        warn "${name} — A 레코드가 없습니다"
        drift=1
    elif [[ "$resolved" == "$current" ]]; then
        ok "${name} → ${resolved}"
    else
        warn "${name} → ${resolved} (지금은 ${current} 입니다)"
        drift=1
    fi
done

if [[ $drift -eq 1 ]]; then
    say ""
    say "가비아 DNS 관리에서 A 레코드를 ${current} 로 고치세요."
    say "이 회선은 유동 IP 이고 자동으로 따라가는 장치가 없습니다."
fi

check_finish
exit $drift
