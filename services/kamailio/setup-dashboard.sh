#!/usr/bin/env bash
#
# kamailio-dashboard 가 뜰 준비가 됐는지 점검한다.
#
#   ./setup-dashboard.sh          점검만 한다 (아무것도 바꾸지 않음)
#   ./setup-dashboard.sh --build  server/web 의존성 설치 + 프런트 빌드
#
# sudo 가 필요한 것은 이 스크립트가 하지 않는다 — 무엇을 실행해야 하는지 알려만 준다.
#
# 이 스크립트가 존재하는 이유는 그룹 문제 하나 때문이다. 대시보드는 Kamailio 상태를
# JSON-RPC FIFO 로 읽는데 그 FIFO 가 kamailio 그룹 전용이고, 그룹은 **로그인 때**
# 정해진다. usermod 을 하고 pm2 를 재시작해도, 재시작한 셸이 usermod 이전에
# 만들어진 것이면 옛 그룹 집합이 그대로 넘어간다. 겉으로는 다 맞아 보이는데
# 대시보드만 "닿지 않습니다" 를 띄우는 상태가 된다. 실제로 한 번 겪었다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FIFO="${KAMAILIO_RPC_FIFO:-/run/kamailio/kamailio_rpc.fifo}"
APP_NAME="kamailio-dashboard"
WEB_DIST="${SCRIPT_DIR}/web/dist/index.html"

MODE="check"
for arg in "$@"; do
    case "$arg" in
        --build) MODE="build" ;;
        --check) MODE="check" ;;
        *) echo "Unknown option: $arg"; echo "Usage: $0 [--check|--build]"; exit 1 ;;
    esac
done

ok()   { echo "  [ok]   $*"; }
no()   { echo "  [--]   $*"; }
warn() { echo "  [!!]   $*"; }
info() { echo "$*"; }

kamailio_gid() { getent group kamailio 2>/dev/null | cut -d: -f3; }

# 주어진 pid 의 보조 그룹에 kamailio gid 가 있는가.
# 파이프로 grep -q 를 물리지 않는다 — pipefail 아래에서 앞 명령이 SIGPIPE 로
# 죽어 거짓 실패가 난다. 변수에 담고 검사한다.
pid_has_group() {
    local pid="$1" gid="$2" line
    [[ -r "/proc/${pid}/status" ]] || return 2
    line="$(grep -E '^Groups:' "/proc/${pid}/status" 2>/dev/null || true)"
    grep -qw "$gid" <<<"$line"
}

pm2_pid_of() {
    pm2 pid "$APP_NAME" 2>/dev/null | tr -d '[:space:]' | grep -E '^[0-9]+$' || true
}

report() {
    local problems=0
    local shell_has_group=unknown
    local gid; gid="$(kamailio_gid)"

    info "그룹"
    if [[ -z "$gid" ]]; then
        warn "kamailio 그룹이 없습니다 — kamailio 가 설치되어 있는지 확인하세요"
        problems=$((problems + 1))
    else
        ok "kamailio 그룹 gid=${gid}"
        local members
        members="$(getent group kamailio | cut -d: -f4 | tr ',' '\n')"
        if grep -qx "$(id -un)" <<<"$members"; then
            ok "/etc/group 에 $(id -un) 등록됨"
        else
            no "/etc/group 에 $(id -un) 이 없습니다"
            info "         sudo usermod -aG kamailio $(id -un)"
            problems=$((problems + 1))
        fi

        # 등록돼 있어도 **이 셸**에 반영됐는지는 별개다.
        #
        # 다만 이건 서비스의 문제가 아니라 "이 셸에서 pm2 를 띄우면 안 된다" 는
        # 참고 사항이다. 이미 올바른 그룹으로 떠 있는 서비스를 문제로 세면,
        # 정상인데 빨간불이 켜져 오히려 헷갈린다. 그래서 세지 않는다.
        local my_groups
        my_groups="$(id -G | tr ' ' '\n')"
        if grep -qx "$gid" <<<"$my_groups"; then
            ok "현재 셸에 그룹이 반영됨"
            shell_has_group=yes
        else
            info "  [i]    현재 셸에는 반영되지 않음 (이 셸이 usermod 보다 먼저 생겼습니다)"
            info "         → 이 셸에서 pm2 를 띄우면 대시보드가 그룹을 못 받습니다. 아래 참고."
            shell_has_group=no
        fi
    fi

    info ""
    info "RPC FIFO"
    # 부모 디렉토리가 drwxrwx--- kamailio 라, 그룹이 없는 셸은 **통과 자체가 안 된다.**
    # 그 상태에서 [[ -e ]] 는 거짓이 되는데 그것을 "없음" 이라고 보고하면 거짓말이다.
    # ("못 봄" 과 "없음" 을 구분한다 — 이 프로젝트에서 같은 실수를 여러 번 했다)
    local fifo_dir; fifo_dir="$(dirname "$FIFO")"
    if [[ ! -x "$fifo_dir" ]]; then
        info "  [i]    확인 불가 — ${fifo_dir} 에 들어갈 권한이 없습니다 (현재 셸 기준)"
        info "         프로세스 쪽 결과를 보세요. 그게 실제로 중요한 것입니다."
    elif [[ ! -e "$FIFO" ]]; then
        no "없음: ${FIFO} — kamailio 가 실행 중인지 확인하세요"
        problems=$((problems + 1))
    elif [[ -w "$FIFO" ]]; then
        ok "쓰기 가능: ${FIFO}"
    else
        no "쓰기 불가: ${FIFO} (현재 셸 기준)"
        problems=$((problems + 1))
    fi

    info ""
    info "프로세스"
    local pid; pid="$(pm2_pid_of)"
    if [[ -z "$pid" || "$pid" == "0" ]]; then
        no "${APP_NAME} 이 pm2 에 떠 있지 않습니다"
        problems=$((problems + 1))
    else
        ok "${APP_NAME} 실행 중 (pid ${pid})"
        if [[ -n "$gid" ]]; then
            if pid_has_group "$pid" "$gid"; then
                ok "그 프로세스가 kamailio 그룹을 가지고 있습니다 — RPC 가 동작합니다"
            else
                warn "그 프로세스에 kamailio 그룹이 없습니다 → 대시보드가 상태를 읽지 못합니다"
                info "         grep ^Groups: /proc/${pid}/status"
                problems=$((problems + 1))
            fi
        fi
    fi

    info ""
    info "빌드"
    if [[ -f "$WEB_DIST" ]]; then
        ok "프런트 빌드 있음: web/dist"
    else
        no "프런트 빌드 없음 — 대시보드 경로가 503 입니다.  $0 --build"
        problems=$((problems + 1))
    fi

    info ""
    if [[ $problems -eq 0 ]]; then
        info "준비 완료. https://<서버>${BASE_PATH:-/kamailio}/dashboard"
        if [[ "$shell_has_group" == "no" ]]; then
            info ""
            info "다만 이 셸에는 kamailio 그룹이 없습니다. 지금 서비스는 올바른 그룹으로"
            info "떠 있지만, **이 셸에서 pm2 를 다시 띄우면 그룹을 잃습니다.**"
            info "아래 스크립트가 그것을 막아 줍니다."
        fi
    else
        info "해결할 항목이 ${problems}개 있습니다."
    fi

    # 그룹 문제를 여기서 손으로 풀라고 적지 않는다. 명령을 옮겨 적게 하면 절대경로를
    # 틀리거나 pm2 restart 로 대신하게 되고, 띄운 뒤 실제로 그룹을 받았는지는 또
    # 따로 확인해야 한다. 그 셋을 한 번에 하는 스크립트가 있다.
    if [[ $problems -gt 0 || "$shell_has_group" == "no" ]]; then
        info ""
        info "그룹은 pm2 데몬을 다시 띄워야 반영됩니다 — 자식이 데몬에게서 물려받기"
        info "때문입니다. pm2 restart 로는 바뀌지 않습니다."
        info ""
        info "  ${PROJECT_ROOT}/pm2/restart.sh              지금 상태를 본다"
        info "  ${PROJECT_ROOT}/pm2/restart.sh --restart    다시 띄우고 확인까지"
        info ""
        info "  이 셸에 그룹이 없으면 --restart 는 거부하고, 다시 로그인할지"
        info "  --sg 로 감쌀지 그 자리에서 알려 줍니다."
    fi
    return 0
}

build() {
    info "server 의존성 설치"
    (cd "${SCRIPT_DIR}/server" && npm install --no-audit --no-fund)
    info "web 의존성 설치 + 빌드"
    (cd "${SCRIPT_DIR}/web" && npm install --no-audit --no-fund && npm run build)
    info ""
    report
}

case "$MODE" in
    check) report ;;
    build) build ;;
esac
