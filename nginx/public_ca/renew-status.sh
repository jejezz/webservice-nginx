#!/usr/bin/env bash
#
# 90일 자동 갱신이 실제로 돌 준비가 됐는지 본다.
#
#   ./renew-status.sh              사람이 읽는 형식
#   ./renew-status.sh --check      같은 것 (판정 줄로)
#   ./renew-status.sh --check --json   구축 마법사용 (docs/check-contract.md)
#
# ── 왜 따로 있나 ─────────────────────────────────────────────────
# cert-status.sh 는 **지금 무엇이 나가고 있나**를 본다. 그것이 멀쩡해도 90일
# 뒤에 조용히 끊기는 길이 셋 있다:
#
#   1. certbot.timer 가 꺼져 있다          → 갱신 자체가 안 돈다
#   2. 갱신 훅이 없다                       → 갱신은 되는데 nginx 가 옛것을 계속 내민다
#   3. 갱신이 실패하고 있다                 → 만료 30일 전부터 조용히
#
# 셋 다 **터지기 전에는 아무 증상이 없다.** 인증서는 멀쩡하고 서비스도 멀쩡해
# 보인다. 그래서 만료를 기다리지 않고 지금 물어보는 점검이 따로 필요하다.
#
# 2번이 가장 고약하다. 파일은 최신인데 접속은 만료로 끊기고, 파일을 봐도
# 아무 이상이 없어서 원인을 찾는 데 오래 걸린다.
#
# ── 권한 ─────────────────────────────────────────────────────────
# sudo 없이 돈다. /etc/letsencrypt/live 는 0700 root 지만, 갱신 설정이 있는
# renewal/ 은 0755 이고 그 안의 .conf 는 0644 다. 갱신에 관해 알고 싶은 것은
# 전부 거기 적혀 있다.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${NGINX_DIR}/.." && pwd)"
SETTINGS_FILE="${SCRIPT_DIR}/settings.ini"

RENEWAL_DIR="/etc/letsencrypt/renewal"
DEPLOY_HOOK_DIR="/etc/letsencrypt/renewal-hooks/deploy"

source "${REPO_ROOT}/lib/check-report.sh"
source "${REPO_ROOT}/lib/site.sh"
check_init "public_ca.renew"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

for a in "$@"; do
    case "$a" in
        --check|"") ;;
        -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

# 절(section)은 쓰지 않는다 — node 쪽(lib/settings.js)도 같은 파일을 파싱한다.
settings_get() {
    local key="$1" v=""
    if [[ -r "$SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
    fi
    echo "${v//[[:space:]]/}"
}
DOMAIN="$(settings_get domain)"
# 여기 안 적혀 있으면 사이트 값을 쓴다 (setup_letsencrypt.sh 와 같은 순서).
[[ -z "$DOMAIN" ]] && DOMAIN="$(site_get host)"

# ──────────────────────────────────────────────────────────────
# 1. 타이머 — certbot 은 설치될 때 자기 systemd 타이머를 함께 깐다.
#    유닛을 우리가 만들 필요가 없고, 만들면 두 개가 겹친다.
# ──────────────────────────────────────────────────────────────
check_timer() {
    info "[1/4] certbot.timer"

    if ! systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
        pend "certbot 이 설치되어 있지 않습니다 — 발급부터 하세요 (./setup_letsencrypt.sh --check)"
        return
    fi

    local active enabled
    active="$(systemctl is-active certbot.timer 2>/dev/null || true)"
    enabled="$(systemctl is-enabled certbot.timer 2>/dev/null || true)"

    if [[ "$active" != "active" ]]; then
        warn "certbot.timer 가 꺼져 있습니다 (${active:-unknown}) — 90일 뒤 조용히 만료됩니다. sudo systemctl enable --now certbot.timer"
        return
    fi

    if [[ "$enabled" != "enabled" ]]; then
        # 지금은 돌지만 재부팅하면 안 돈다. 만료는 90일 뒤라 그사이 재부팅을
        # 한 번이라도 하면 아무도 모르는 채로 멈춘다.
        warn "certbot.timer 가 지금은 돌지만 부팅 등록이 안 돼 있습니다 (${enabled:-unknown}) — sudo systemctl enable certbot.timer"
        return
    fi

    local next
    next="$(systemctl show certbot.timer -p NextElapseUSecRealtime --value 2>/dev/null || true)"
    if [[ -n "$next" && "$next" != "n/a" ]]; then
        ok "certbot.timer 활성·부팅 등록됨 — 다음 실행 ${next}"
    else
        ok "certbot.timer 활성·부팅 등록됨"
    fi
}

# ──────────────────────────────────────────────────────────────
# 2. 갱신 훅 — 이게 없으면 certbot 이 조용히 갱신해 두어도 nginx 는 메모리에
#    올린 옛 인증서를 계속 내민다. 파일은 최신인데 접속은 만료로 끊긴다.
# ──────────────────────────────────────────────────────────────
hook_in_conf() {
    # certbot 은 --deploy-hook 으로 준 것을 renewal conf 에 renew_hook 으로 적는다.
    grep -Eqi '^[[:space:]]*(renew_hook|post_hook)[[:space:]]*=.*nginx' "$1"
}

# 모든 인증서에 걸리는 전역 훅. 여기에 실행 파일이 있으면 conf 에 훅이 없어도 된다.
global_deploy_hook() {
    [[ -d "$DEPLOY_HOOK_DIR" ]] || return 1
    compgen -G "${DEPLOY_HOOK_DIR}/*" >/dev/null 2>&1
}

check_hook() {
    info "[2/4] 갱신 훅 (systemctl reload nginx)"

    if [[ ! -d "$RENEWAL_DIR" ]]; then
        pend "아직 발급받은 인증서가 없습니다 (${RENEWAL_DIR} 없음)"
        return
    fi
    if [[ ! -r "$RENEWAL_DIR" || ! -x "$RENEWAL_DIR" ]]; then
        skip "${RENEWAL_DIR} 를 읽지 못해 갱신 훅을 확인할 수 없습니다 (권한)"
        return
    fi

    # 볼 대상. settings.ini 에 도메인이 있으면 그것만, 없으면 시험용을 뺀 전부.
    local confs=()
    if [[ -n "$DOMAIN" ]]; then
        [[ -r "${RENEWAL_DIR}/${DOMAIN}.conf" ]] && confs+=("${RENEWAL_DIR}/${DOMAIN}.conf")
    else
        local f
        for f in "${RENEWAL_DIR}"/*.conf; do
            [[ -r "$f" ]] || continue
            [[ "$f" == *-staging.conf ]] && continue
            confs+=("$f")
        done
    fi

    if [[ ${#confs[@]} -eq 0 ]]; then
        if [[ -n "$DOMAIN" ]]; then
            pend "${DOMAIN} 의 갱신 설정이 없습니다 — 아직 발급받지 않았습니다"
        else
            pend "발급받은 인증서가 없습니다 — ./setup_letsencrypt.sh --staging 부터 하세요"
        fi
        return
    fi

    if global_deploy_hook; then
        ok "전역 배포 훅이 있습니다 (${DEPLOY_HOOK_DIR}) — 모든 인증서에 걸립니다"
        return
    fi

    local c name
    for c in "${confs[@]}"; do
        name="$(basename "$c" .conf)"
        if hook_in_conf "$c"; then
            ok "${name} — 갱신되면 nginx 가 다시 읽습니다 (renew_hook)"
        else
            # 고장이다. 지금은 멀쩡해 보이지만 갱신되는 날 조용히 깨진다.
            warn "${name} — 갱신 훅이 없습니다. 갱신돼도 nginx 는 옛 인증서를 계속 내밉니다. sudo ./setup_letsencrypt.sh --prod 로 다시 받으면 훅까지 함께 걸립니다"
        fi
    done
}

# ──────────────────────────────────────────────────────────────
# 3. 만료까지 남은 날 — 지금 **내밀고 있는** 것을 기준으로 본다.
#    디스크의 파일이 아니라 나가는 것이 기준이어야 2번의 사고가 드러난다.
# ──────────────────────────────────────────────────────────────
check_expiry() {
    info "[3/4] 만료까지"

    local status_json days
    status_json="$("${SCRIPT_DIR}/cert-status.sh" --json 2>/dev/null || true)"
    days="$(printf '%s' "$status_json" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("daysLeft", "") if d.get("ok") else "")
except Exception:
    print("")' 2>/dev/null || true)"

    if [[ -z "$days" ]]; then
        skip "지금 내밀고 있는 인증서를 읽지 못해 만료를 보지 못했습니다"
        return
    fi

    # certbot 은 만료 30일 전부터 하루 두 번 갱신을 시도한다. 그래서
    #   30일 이상   정상
    #   20~30일     막 넘어온 참일 수 있다. 아직 문제라고 하지 않는다
    #   7~20일      열흘 넘게 시도해서 다 실패했다는 뜻이다
    #   7일 미만    곧 끊긴다
    if (( days >= 30 )); then
        ok "만료까지 ${days}일 — certbot 은 30일 전부터 갱신합니다"
    elif (( days >= 20 )); then
        ok "만료까지 ${days}일 — 갱신 구간에 들어왔습니다. 곧 갱신됩니다"
    elif (( days >= 7 )); then
        pend "만료까지 ${days}일 — 갱신 구간(30일)에 들어온 지 열흘이 넘었는데 아직 갱신되지 않았습니다. sudo certbot renew --dry-run 으로 이유를 보세요"
    else
        warn "만료까지 ${days}일 — 갱신이 돌지 않고 있습니다. sudo certbot renew --force-renewal"
    fi
}

# ──────────────────────────────────────────────────────────────
# 4. 마지막 갱신 시도가 어떻게 끝났나. 한 번도 안 돌았으면 말하지 않는다 —
#    새로 발급받은 직후가 그렇고, 그것은 잘못이 아니다.
# ──────────────────────────────────────────────────────────────
check_last_run() {
    info "[4/4] 마지막 갱신 시도"

    if ! systemctl list-unit-files certbot.service >/dev/null 2>&1; then
        skip "certbot.service 가 없어 마지막 시도를 보지 못했습니다"
        return
    fi

    local when code
    when="$(systemctl show certbot.service -p ExecMainExitTimestamp --value 2>/dev/null || true)"
    code="$(systemctl show certbot.service -p ExecMainStatus --value 2>/dev/null || true)"

    if [[ -z "$when" || "$when" == "n/a" ]]; then
        skip "아직 한 번도 돌지 않았습니다 (발급한 지 얼마 안 됐다면 정상입니다)"
        return
    fi

    if [[ "$code" == "0" ]]; then
        ok "마지막 시도 ${when} — 정상"
    else
        warn "마지막 시도 ${when} 가 실패했습니다 (종료 코드 ${code}). journalctl -u certbot.service 를 보세요"
    fi
}

info "자동 갱신 점검${DOMAIN:+ — ${DOMAIN}}"
info ""

check_timer
check_hook
check_expiry
check_last_run

check_finish

# 사람이 보는 모드. 판정에 따라 종료 코드를 맞춘다.
state="$(check_state)"
echo
case "$state" in
    complete) echo "자동 갱신이 돌 준비가 돼 있습니다." ;;
    *)        echo "위의 [--] 와 [!!] 를 보세요. 지금은 멀쩡해도 갱신되는 날 깨집니다." ;;
esac
[[ "$state" == "complete" ]] && exit 0 || exit 1
