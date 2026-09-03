#!/usr/bin/env bash
#
# 계획서 9-4 — 공인 IP 가 바뀌었는지 본다. sudo 가 필요 없다.
#
#   ./check-public-ip.sh              지금 값과 설치된 값을 비교한다
#   ./check-public-ip.sh --write      현재 값을 settings.ini 에 쓴다 (적용은 별개)
#   sudo ./check-public-ip.sh --sync  설치된 janus.jcfg 의 nat_1_1_mapping 을
#                                     지금 값으로 맞춘다 (Janus 기동 전에 쓴다)
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
# 이 회선을 가리키는 공개 이름. 외부 IP 확인 서비스에 묻지 않고 DNS 로만
# 알아낸다 — 바깥에 요청을 하나 덜 보낸다.
#
# 예전에는 공유기의 DDNS(jejezzhome.iptime.org)를 봤지만 그 이름은 삭제됐다.
# 지금은 등록기관에 둔 A 레코드를 본다. 이름이 고정값이라 회선 IP 가 바뀌면
# 레코드를 갱신해 주어야 한다 — 공유기가 알아서 하던 일이 사라졌다.
#
# ── 어느 이름을 보는가 ──────────────────────────────────────────────────
#
# **이 장비가 실제로 맡은 단지의 이름이어야 한다.** 예전에는 여기에 특정
# 단지의 이름을 하드코딩해 두었었다 — 그 값은 이 스크립트가 어느 장비에
# 설치되든 항상 같았으므로, site 층(site/settings.ini)의 host 를 설정하지
# 않은 장비나 JANUS_DDNS_NAME 을 안 준 호출은 전부 **남의 단지 이름을 보고
# 있었다.** janus-public-ip.service 가 부팅마다 그 값으로 조용히 동기화해
# 실제 있지도 않은 주소를 ICE 후보로 광고하게 만든 사고가 실제로 있었다
# (신호는 붙고 소리만 안 나는 모양이라 알아채기 어렵다).
#
# 그래서 이제 하드코딩된 값을 두지 않는다. site/settings.ini 의 host 를
# 보고, 그것도 없으면(site 층이 없는 배치) JANUS_DDNS_NAME 도 없을 때는
# **모른다** 로 남긴다 — 아래에서 이름 해석에 실패해 skip 으로 끝난다.
SITE_SETTINGS="${SCRIPT_DIR}/../../site/settings.ini"
site_host=""
if [[ -r "$SITE_SETTINGS" ]]; then
    site_host="$(sed -n 's/^[[:space:]]*host[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' "$SITE_SETTINGS" | tail -1)"
fi
DDNS_NAME="${JANUS_DDNS_NAME:-$site_host}"

# 점검 출력은 공용 규약을 따른다 (docs/check-contract.md).
source "${SCRIPT_DIR}/../../lib/check-report.sh"

# --json 은 아래 인자 파싱보다 **먼저** 걸러낸다.
check_init "janus.publicip"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

QUIET=0
WRITE=0
SYNC=0
for a in "$@"; do
    case "$a" in
        --quiet) QUIET=1 ;;
        --write) WRITE=1 ;;
        --sync)  SYNC=1 ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $a" >&2; exit 2 ;;
    esac
done

# JSON 모드에서도 조용해야 한다 — stdout 은 JSON 한 덩어리여야 하므로.
say() { [[ $QUIET -eq 1 || $CHECK_JSON -eq 1 ]] || echo "$@"; }

# ── 지금의 공인 IP ──────────────────────────────────────────────────────
if [[ -z "$DDNS_NAME" ]]; then
    judge skip "이 단지의 이름을 모릅니다 (site/settings.ini 의 host 도, JANUS_DDNS_NAME 도 없습니다)"
    check_finish
    echo "확인 불가: site/settings.ini 의 host 를 채우거나 JANUS_DDNS_NAME 을 주세요" >&2
    exit 2
fi

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

# ── --sync : 기동 전에 설치본을 지금 값으로 맞춘다 ──────────────────────
#
# janus-public-ip.service 가 Janus 기동 직전에 이것을 부른다. 가정용 회선은
# 공인 IP 가 바뀌는데, Janus 는 기동할 때 읽은 값을 ICE 후보로 계속 광고한다.
# 그래서 **기동 직전**이 고칠 수 있는 유일한 자리다.
#
# 규칙 하나: **없는 줄을 만들지 않는다.** nat_1_1_mapping 이 없다는 것은 LAN
# 전용으로 설치했다는 뜻이고, 그것은 사람이 정한 것이다. 부팅 때 조용히 켜서
# 외부로 주소를 광고하기 시작하면 안 된다.
if [[ $SYNC -eq 1 ]]; then
    [[ $EUID -eq 0 ]] || { echo "--sync 는 root 로 실행해야 합니다 (설치본을 고칩니다)" >&2; exit 2; }

    if [[ ! -f "$INSTALLED_CFG" ]]; then
        say "설치된 설정이 없습니다: ${INSTALLED_CFG} — 할 일이 없습니다."
        exit 0
    fi
    if ! grep -qE '^[[:space:]]*nat_1_1_mapping[[:space:]]*=' "$INSTALLED_CFG"; then
        say "LAN 전용으로 설치돼 있습니다 (nat_1_1_mapping 없음) — 그대로 둡니다."
        say "  켜려면: settings.ini 의 public_ip 를 채우고 sudo ./install.sh --apply"
        exit 0
    fi
    if [[ "$installed" == "$current" ]]; then
        say "이미 같습니다: ${current} — 고치지 않습니다."
        exit 0
    fi

    sed -i "s|^\([[:space:]]*nat_1_1_mapping[[:space:]]*=[[:space:]]*\)\"[^\"]*\"|\1\"${current}\"|" "$INSTALLED_CFG"
    logger -t janus-publicip "nat_1_1_mapping ${installed:-(없음)} → ${current}" 2>/dev/null || true
    say "설치본을 고쳤습니다: ${installed:-(비어 있음)} → ${current}"

    # 저장소 쪽 값도 따라가게 둔다. 그러지 않으면 점검이 '반영 안 됨' 으로 본다.
    # 부팅 중에는 이 파일들이 없을 수도 있어(홈이 늦게 붙는 등) 실패해도 넘어간다.
    for f in "$SETTINGS_FILE" "$APPLIED_FILE"; do
        [[ -w "$f" ]] || continue
        grep -qE '^[[:space:]]*public_ip[[:space:]]*=' "$f" \
            && sed -i "s|^[[:space:]]*public_ip[[:space:]]*=.*|public_ip = ${current}|" "$f" \
            || printf 'public_ip = %s\n' "$current" >> "$f"
    done
    exit 0
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
