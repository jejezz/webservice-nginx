#!/usr/bin/env bash
#
# 계획서 9-4 — 공인 IP 가 바뀌었는지 본다. sudo 가 필요 없다.
#
#   ./check-public-ip.sh              지금 값과 설치된 값을 비교한다
#   ./check-public-ip.sh --write      현재 값을 settings.ini 에 쓴다 (적용은 별개)
#
# settings.ini 는 대시보드의 '설정' 화면도 씁니다. 이 스크립트는 public_ip 줄만
# 건드리고 나머지 값은 그대로 둡니다.
#
# 왜 필요한가 — 가정용 회선은 공인 IP 가 바뀝니다. 바뀌는 순간부터 Janus 는
# **낡은 주소를 ICE 후보로 광고**하고, 외부 브라우저와의 통화는 신호는 붙는데
# 소리가 나지 않는 모양이 됩니다. 화면 어디에도 오류가 뜨지 않아 원인을 짚기
# 어렵습니다. 그래서 주기적으로 이것만 확인합니다.
#
# 종료 코드 — 0 같음 · 1 다름(조치 필요) · 2 확인 불가
#
# crontab 예:
#   */30 * * * * /home/jejezz/Public/webservices/services/janus/check-public-ip.sh --quiet \
#                || echo "janus: 공인 IP 가 바뀌었습니다" | logger -t janus-natcheck
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"
APPLIED_FILE="${SCRIPT_DIR}/.applied-settings"
INSTALLED_CFG="/opt/janus/etc/janus/janus.jcfg"
# 이 회선의 DDNS 이름. 외부 IP 확인 서비스에 묻지 않고 DNS 로만 알아낸다 —
# 어차피 공유기가 갱신하고 있고, 바깥에 요청을 하나 덜 보낸다.
DDNS_NAME="${JANUS_DDNS_NAME:-jejezzhome.iptime.org}"

# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
source "${SCRIPT_DIR}/../../lib/check-report.sh"

# --json 은 아래 인자 파싱보다 **먼저** 걸러낸다.
check_init "janus.publicip"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

QUIET=0
WRITE=0
for a in "$@"; do
    case "$a" in
        --quiet) QUIET=1 ;;
        --write) WRITE=1 ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $a" >&2; exit 2 ;;
    esac
done

# JSON 모드에서도 조용해야 한다 — stdout 은 JSON 한 덩어리여야 하므로.
say() { [[ $QUIET -eq 1 || $CHECK_JSON -eq 1 ]] || echo "$@"; }

# ── 지금의 공인 IP ──────────────────────────────────────────────────────
current="$(getent hosts "$DDNS_NAME" 2>/dev/null | awk '{print $1}' | head -1)"
if [[ -z "$current" ]]; then
    judge skip "${DDNS_NAME} 를 해석하지 못해 공인 IP 를 확인할 수 없습니다"
    check_finish
    echo "확인 불가: ${DDNS_NAME} 를 해석하지 못했습니다" >&2
    exit 2
fi
say "현재 공인 IP   ${current}   (${DDNS_NAME})"

# ── 저장소가 들고 있는 값 ───────────────────────────────────────────────
ini_get() {
    local key="$1" file="$2" v=""
    [[ -r "$file" ]] || { echo ""; return 0; }
    v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\\(.*\\)$/\\1/p" "$file" | tail -1)"
    v="${v%%[;#]*}"
    echo "${v//[[:space:]]/}"
}

declared="$(ini_get public_ip "$SETTINGS_FILE")"
say "settings.ini    ${declared:-(비어 있음 — LAN 전용)}"

applied="$(ini_get public_ip "$APPLIED_FILE")"
if [[ -r "$APPLIED_FILE" ]]; then
    say "마지막 적용     ${applied:-(비어 있음)}"
else
    say "마지막 적용     (기록 없음 — 아직 --apply 한 적이 없습니다)"
fi

# ── 실제로 Janus 가 쓰고 있는 값 ────────────────────────────────────────
#
# 설치된 janus.jcfg 는 0640 root:janus 라 보통 읽지 못한다. 못 읽는 것이
# 정상이므로 오류로 다루지 않는다 — 그때는 public-ip 파일까지만 본다.
installed=""
if [[ -r "$INSTALLED_CFG" ]]; then
    installed="$(sed -n 's/^[[:space:]]*nat_1_1_mapping[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALLED_CFG" | head -1)"
    say "설치된 설정     ${installed:-(nat_1_1_mapping 없음 — LAN 전용)}"
else
    say "설치된 설정     읽을 수 없음 (0640 root:janus — 정상입니다)"
fi

if [[ $WRITE -eq 1 ]]; then
    umask 022
    # public_ip 줄만 갈아 끼운다. 대시보드가 쓴 다른 값은 그대로 둔다.
    if [[ -r "$SETTINGS_FILE" ]] && grep -qE '^[[:space:]]*public_ip[[:space:]]*=' "$SETTINGS_FILE"; then
        sed -i "s|^[[:space:]]*public_ip[[:space:]]*=.*|public_ip = ${current}|" "$SETTINGS_FILE"
    else
        [[ -f "$SETTINGS_FILE" ]] || printf '; janus 배포 설정\n' > "$SETTINGS_FILE"
        printf 'public_ip = %s\n' "$current" >> "$SETTINGS_FILE"
    fi
    say
    say "settings.ini 의 public_ip 를 ${current} 로 적었습니다."
    say "아직 Janus 에는 반영되지 않았습니다 — 다음을 실행하세요:"
    say "    sudo ./install.sh --apply"
    exit 0
fi

# ── 판정 ────────────────────────────────────────────────────────────────
# 비교 대상은 '실제로 Janus 가 쓰는 값' 이 우선이고, 못 읽으면 public-ip 파일이다.
reference="${installed:-${applied:-$declared}}"

[[ $CHECK_JSON -eq 1 ]] || echo
if [[ -z "$reference" ]]; then
    judge skip "LAN 전용으로 설치돼 있습니다 (nat_1_1_mapping 없음)"
    check_finish
    say "판정: LAN 전용으로 설치돼 있습니다. 외부 브라우저를 받으려면 9단계를 켜세요."
    say "      ./check-public-ip.sh --write && sudo ./install.sh --apply"
    exit 0
fi

if [[ "$reference" == "$current" ]]; then
    judge ok "광고 중인 공인 IP 가 현재 값과 같습니다 (${current})"
    check_finish
    say "판정: 같습니다 — 외부 통화의 ICE 후보 주소가 유효합니다."
    exit 0
fi

judge problem "Janus 는 ${reference} 를 광고하는데 지금 공인 IP 는 ${current} 입니다 — 외부 통화가 무음이 됩니다"
check_finish
echo "판정: ⚠️ 다릅니다 — Janus 는 ${reference} 를 광고하는데 지금 공인 IP 는 ${current} 입니다."
echo "      이 상태에서는 외부 브라우저와 신호는 붙고 **소리가 나지 않습니다.**"
echo "      고치려면:"
echo "          ./check-public-ip.sh --write"
echo "          sudo ./install.sh --apply"
exit 1
