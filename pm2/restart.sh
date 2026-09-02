#!/usr/bin/env bash
#
# pm2 데몬을 **그룹까지 갖춰서** 다시 띄운다. 그리고 확인한다.
#
#   ./restart.sh                지금 상태를 본다 (아무것도 바꾸지 않음)
#   ./restart.sh --restart      pm2 kill 후 다시 띄우고, 잠시 뒤 확인한다
#   ./restart.sh --restart --sg 다시 로그인하지 않고 sg 로 감싸서 (임시 조치)
#
# ── 왜 이 스크립트가 있는가 ─────────────────────────────────────────────
#
# 어떤 앱은 보조 그룹이 있어야 일을 한다. kamailio-dashboard 는 Kamailio 의
# JSON-RPC FIFO 를 읽는데 /run/kamailio 가 drwxrwx--- kamailio:kamailio 다.
#
# 그런데 보조 그룹은 **로그인할 때** initgroups() 로 한 번 정해지고 그 뒤로는
# 자식에게 그대로 상속된다. usermod -aG 는 /etc/group 만 고치므로, 이미 떠 있는
# 셸과 그 셸이 띄운 pm2 데몬은 옛 그룹 집합을 계속 쓴다. pm2 restart 로도
# 바뀌지 않는다 — 데몬이 자식에게 물려주므로 **데몬 자체를 다시 띄워야** 한다.
#
# 그래서 손으로는 이런 주문을 외우게 된다.
#
#   pm2 kill && sg kamailio -c "cd <프로젝트>/pm2 && pm2 start ecosystem.config.js && pm2 save"
#
# 절대경로가 박힌 한 줄을 문서에 적어 두는 대신, 여기서 한다. 필요한 그룹은
# 선언에서 읽는다 — services/*/pm2-conf/*.ini 의 [app] 에 groups 를 적으면 된다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ECOSYSTEM="${SCRIPT_DIR}/ecosystem.config.js"

# 재기동 뒤 확인까지 기다리는 시간. 앱이 포트를 잡고 헬스가 뜨는 데 걸리는 만큼.
SETTLE_SECONDS="${PM2_RESTART_SETTLE:-6}"

MODE="check"
USE_SG=false
for arg in "$@"; do
    case "$arg" in
        --restart) MODE="restart" ;;
        --check)   MODE="check" ;;
        --sg)      USE_SG=true ;;
        *) echo "Unknown option: $arg"
           echo "Usage: $0 [--check|--restart] [--sg]"; exit 1 ;;
    esac
done

ok()   { echo "  [ok]   $*"; }
no()   { echo "  [--]   $*"; }
warn() { echo "  [!!]   $*"; }
info() { echo "$*"; }
die()  { echo "오류: $*" >&2; exit 1; }

# ── 선언에서 필요한 그룹을 읽는다 ───────────────────────────────────────
#
# services/*/pm2-conf/*.ini 의 [app] 절에서 enabled 와 groups 를 본다.
# groups 는 쉼표로 여럿 적을 수 있다. enabled = false 인 앱은 세지 않는다.
#
# ini 를 여기서 직접 읽는 이유는, ecosystem.config.js 가 pm2 에 넘기는 객체에는
# 이 값이 실리지 않기 때문이다 (pm2 가 모르는 필드다). 선언의 자리는 같게 두고
# 읽는 쪽만 따로 둔다.
declare -A GROUP_WANTED_BY=()

collect_groups() {
    local file app_name enabled groups
    while IFS= read -r file; do
        [[ -f "$file" ]] || continue
        app_name="$(awk -F= '/^\[app\]/{s=1;next} /^\[/{s=0} s && $1 ~ /^[[:space:]]*name[[:space:]]*$/ {gsub(/[[:space:]]/,"",$2); print $2; exit}' "$file")"
        enabled="$(awk -F= '/^\[app\]/{s=1;next} /^\[/{s=0} s && $1 ~ /^[[:space:]]*enabled[[:space:]]*$/ {gsub(/[[:space:]]/,"",$2); print $2; exit}' "$file")"
        groups="$(awk -F= '/^\[app\]/{s=1;next} /^\[/{s=0} s && $1 ~ /^[[:space:]]*groups[[:space:]]*$/ {sub(/^[^=]*=/,""); print; exit}' "$file")"

        [[ "${enabled,,}" == "false" ]] && continue
        [[ -z "$groups" ]] && continue

        local g
        IFS=',' read -ra list <<<"$groups"
        for g in "${list[@]}"; do
            g="$(echo "$g" | xargs)"
            [[ -z "$g" ]] && continue
            GROUP_WANTED_BY["$g"]="${GROUP_WANTED_BY[$g]:+${GROUP_WANTED_BY[$g]}, }${app_name:-$(basename "$(dirname "$(dirname "$file")")")}"
        done
    done < <(find "${PROJECT_ROOT}/services" -mindepth 3 -maxdepth 3 -path '*/pm2-conf/*.ini' 2>/dev/null | sort)
}

gid_of()  { getent group "$1" 2>/dev/null | cut -d: -f3; }

# 주어진 pid 의 보조 그룹 집합. 읽지 못하면 2 로 알린다 — "없다" 와 다르다.
pid_groups() {
    local pid="$1"
    [[ -r "/proc/${pid}/status" ]] || return 2
    grep -E '^Groups:' "/proc/${pid}/status" 2>/dev/null | cut -f2-
}

pid_has_gid() {
    local line; line="$(pid_groups "$1")" || return 2
    grep -qw "$2" <<<"$line"
}

daemon_pid() { pgrep -f 'God Daemon' 2>/dev/null | head -1 || true; }

# 지금 셸에 없는 그룹들.
missing_in_shell() {
    local g gid
    for g in "${!GROUP_WANTED_BY[@]}"; do
        gid="$(gid_of "$g")"
        [[ -z "$gid" ]] && { echo "$g"; continue; }          # 그룹 자체가 없다
        id -G | tr ' ' '\n' | grep -qx "$gid" || echo "$g"
    done
}

# ── 점검 ────────────────────────────────────────────────────────────────

report() {
    local problems=0 g gid target

    info "필요한 그룹 (services/*/pm2-conf/*.ini 의 groups)"
    if [[ ${#GROUP_WANTED_BY[@]} -eq 0 ]]; then
        ok "그룹을 요구하는 앱이 없습니다"
    else
        for g in "${!GROUP_WANTED_BY[@]}"; do
            gid="$(gid_of "$g")"
            if [[ -z "$gid" ]]; then
                warn "${g} — 이 장비에 그런 그룹이 없습니다 (${GROUP_WANTED_BY[$g]})"
                problems=$((problems + 1))
            else
                ok "${g} (gid ${gid}) — ${GROUP_WANTED_BY[$g]}"
            fi
        done
    fi

    info ""
    info "지금 셸"
    local miss; mapfile -t miss < <(missing_in_shell)
    if [[ ${#miss[@]} -eq 0 ]]; then
        ok "필요한 그룹을 모두 갖고 있습니다"
    else
        no "빠진 그룹: ${miss[*]}"
        target="${SUDO_USER:-$(id -un)}"
        for g in "${miss[@]}"; do
            if getent group "$g" >/dev/null 2>&1 && getent group "$g" | cut -d: -f4 | tr ',' '\n' | grep -qx "$target"; then
                info "         ${target} 는 /etc/group 의 ${g} 에 있습니다 — **다시 로그인**하면 반영됩니다"
            else
                info "         sudo usermod -aG ${g} ${target}   후 다시 로그인"
            fi
        done
        problems=$((problems + 1))
    fi

    info ""
    info "pm2 데몬"
    local dpid; dpid="$(daemon_pid)"
    if [[ -z "$dpid" ]]; then
        no "떠 있지 않습니다"
    else
        ok "pid ${dpid}"
        for g in "${!GROUP_WANTED_BY[@]}"; do
            gid="$(gid_of "$g")" || true
            [[ -z "$gid" ]] && continue
            if pid_has_gid "$dpid" "$gid"; then
                ok "  ${g}(${gid}) 있음"
            else
                warn "  ${g}(${gid}) 없음 — 이 데몬이 띄운 앱은 전부 못 갖습니다"
                problems=$((problems + 1))
            fi
        done
    fi

    info ""
    info "앱"
    if ! command -v pm2 >/dev/null 2>&1; then
        warn "pm2 가 없습니다"
        return 1
    fi
    local line name status restarts
    while IFS='|' read -r name status restarts; do
        [[ -z "$name" ]] && continue
        case "$status" in
            online) ok "$(printf '%-24s' "$name") online (재시작 ${restarts}회)" ;;
            *)      warn "$(printf '%-24s' "$name") ${status} (재시작 ${restarts}회) — pm2 logs ${name}"
                    problems=$((problems + 1)) ;;
        esac
    done < <(pm2 jlist 2>/dev/null | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        let a=[];try{a=JSON.parse(s)}catch(e){}
        for (const p of a) console.log([p.name,(p.pm2_env||{}).status,(p.pm2_env||{}).restart_time].join("|"));
      });' 2>/dev/null || true)

    info ""
    if [[ $problems -eq 0 ]]; then
        info "모두 정상입니다."
    else
        info "남은 항목 ${problems}개."
        [[ "$MODE" == "check" ]] && info "  다시 띄우려면: $0 --restart"
    fi
    return 0
}

# ── 재기동 ──────────────────────────────────────────────────────────────

start_command() {
    printf 'cd %q && pm2 start %q && pm2 save' "$SCRIPT_DIR" "$ECOSYSTEM"
}

# sg 를 그룹 수만큼 겹쳐 감싼다. sg 는 한 번에 하나만 받는다.
wrap_in_sg() {
    local cmd="$1"; shift
    local g
    for g in "$@"; do
        cmd="$(printf 'sg %q -c %q' "$g" "$cmd")"
    done
    printf '%s' "$cmd"
}

do_restart() {
    [[ -f "$ECOSYSTEM" ]] || die "선언이 없습니다: ${ECOSYSTEM}"
    command -v pm2 >/dev/null 2>&1 || die "pm2 가 없습니다. pm2/install_pm2.sh 를 먼저 보세요."

    local miss; mapfile -t miss < <(missing_in_shell)
    local cmd; cmd="$(start_command)"

    if [[ ${#miss[@]} -gt 0 ]]; then
        if $USE_SG; then
            info "빠진 그룹 ${miss[*]} — sg 로 감싸서 띄웁니다."
            info "⚠️ 임시 조치입니다. 데몬의 **기본 그룹**이 바뀌고, 다음 부팅에는 남지 않습니다."
            info "   제대로 고치려면 다시 로그인한 뒤 --sg 없이 실행하세요."
            cmd="$(wrap_in_sg "$cmd" "${miss[@]}")"
        else
            warn "지금 셸에 그룹이 없습니다: ${miss[*]}"
            info ""
            info "이 셸로 띄우면 대시보드가 Kamailio 에 닿지 못합니다. 둘 중 하나로 하세요."
            info ""
            info "  ① 다시 로그인한 뒤 (권장 — 재부팅 후에도 유효)"
            info "       $0 --restart"
            info ""
            info "  ② 로그아웃 없이 (임시 조치)"
            info "       $0 --restart --sg"
            exit 1
        fi
    fi

    info "pm2 kill …"
    pm2 kill >/dev/null 2>&1 || true

    info "다시 띄웁니다 …"
    bash -lc "$cmd" >/dev/null || die "기동에 실패했습니다. bash -lc \"${cmd}\" 를 직접 실행해 보세요."

    info "자리 잡기를 ${SETTLE_SECONDS}초 기다립니다 …"
    sleep "$SETTLE_SECONDS"

    info ""
    info "── 확인 ────────────────────────────────────────────────────────"
    info ""
    report
}

collect_groups
case "$MODE" in
    check)   report ;;
    restart) do_restart ;;
esac
