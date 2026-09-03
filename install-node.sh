#!/usr/bin/env bash
#
# Node.js 20 이상을 NodeSource 에서 설치한다.
#
#   ./install-node.sh                 지금 상태만 본다 (아무것도 바꾸지 않음)
#   sudo ./install-node.sh --apply    설치한다
#   sudo ./install-node.sh --apply -y 확인 없이 진행
#   sudo ./install-node.sh --remove   걷어내고 배포판 상태로 되돌린다
#
# ── 왜 이 스크립트가 있는가 ──────────────────────────────────────────
#
# bootstrap.sh 가 node 20 이상을 요구한다. 배포판 apt 는 22.04 가 12, 24.04 가
# 18 이라 **어느 쪽도 그것만으로는 안 된다.** 그리고 NodeSource 를 붙이는 길에
# 함정이 둘 있어서, 손으로 하면 매 장비마다 같은 자리에서 멈춘다.
#
#   1. libnode-dev 와 /usr/include/node/ 를 다툰다. NodeSource 패키지는
#      Conflicts 에 `nodejs-dev` 를 적어 두었는데 우분투가 그것을 `libnode-dev`
#      로 개명해서, 이름이 어긋나 dpkg 가 파일 충돌로 멈춘다
#   2. 배포판 npm 도 같다. `Replaces: npm (<= 1.2.14)` 가 jammy 의 8.5.1 을
#      덮지 못한다. npm 은 애초에 따로 설치할 것이 아니다 — NodeSource 의
#      nodejs 패키지가 담고 있다
#
# 자세한 배경은 docs/nodejs-install.md 에 있다.
#
# ── 하는 것과 하지 않는 것 ───────────────────────────────────────────
#
# **기본은 점검이다.** 인자 없이 부르면 아무것도 바꾸지 않고 지금 상태만 말한다.
# 바꾸는 것은 --apply 를 줄 때뿐이고, 그때도 지울 패키지를 먼저 보여 주고
# 묻는다. 남의 장비에서 무엇이 사라졌는지 모르는 상태를 만들지 않기 위해서다.
#
# 여러 번 돌려도 안전하다.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 설치할 major. 20 이 하한이라 기본값이다. 더 올리려면 NODE_MAJOR=22 로 부른다.
NODE_MAJOR="${NODE_MAJOR:-20}"
MIN_MAJOR=20

KEYRING="/usr/share/keyrings/nodesource.gpg"
LIST="/etc/apt/sources.list.d/nodesource.list"
# dist-upgrade 가 서드파티 저장소를 끌 때 붙이는 이름. 이 장비에서 실제로 나왔다.
STALE="${LIST}.distUpgrade"
PIN="/etc/apt/preferences.d/nodejs"
KEY_URL="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"

MODE="check"
ASSUME_YES=0
for a in "$@"; do
    case "$a" in
        --apply)   MODE="apply" ;;
        --remove)  MODE="remove" ;;
        -y|--yes)  ASSUME_YES=1 ;;
        -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { echo "  ${GREEN}✓${OFF} $*"; }
todo() { echo "  ${YELLOW}·${OFF} $*"; }
bad()  { echo "  ${RED}✗${OFF} $*"; }
step() { echo; echo "${DIM}──${OFF} $*"; }
run()  { echo "  ${DIM}\$ $*${OFF}"; "$@"; }

PROBLEMS=0

confirm() {
    [[ $ASSUME_YES -eq 1 ]] && return 0
    local reply=""
    read -r -p "  $1 [y/N] " reply
    [[ "$reply" == "y" || "$reply" == "Y" ]]
}

need_root() {
    if [[ ${EUID} -ne 0 ]]; then
        bad "이 모드는 root 가 필요합니다 — sudo $0 $*"
        exit 1
    fi
}

# ── 지금 무엇이 깔려 있나 ────────────────────────────────────────────

# 설치된 패키지인가 (rc 상태는 아니다).
installed() { [[ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" == "installed" ]]; }

node_major() {
    command -v node >/dev/null 2>&1 || { echo 0; return; }
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# NodeSource 가 넣은 nodejs 인가. 배포판 것과 구분해야 안내가 달라진다.
from_nodesource() {
    dpkg-query -W -f='${Version}' nodejs 2>/dev/null | grep -q nodesource
}

# NodeSource nodejs 가 실어 오는 경로를 지금 누가 갖고 있는지 본다. nodejs 가
# 아닌 패키지가 쥐고 있으면 그것이 --unpack 에서 부딪힌다.
#
# 하드코딩한 이름(libnode-dev·npm)만 보지 않는 이유는, 이 개명이 배포판마다
# 또 달라질 수 있어서다. 실제로 부딪히는 것은 이름이 아니라 파일이다.
CONFLICT_PATHS=(/usr/include/node/common.gypi /usr/bin/npm /usr/bin/npx /usr/bin/node)
conflicting_packages() {
    local p owner
    for p in "${CONFLICT_PATHS[@]}"; do
        [[ -e "$p" ]] || continue
        owner="$(dpkg -S "$p" 2>/dev/null | head -1 | cut -d: -f1)" || true
        [[ -z "$owner" || "$owner" == "nodejs" ]] && continue
        echo "$owner"
    done | sort -u
}

report() {
    step "이 장비"

    local id="" ver=""
    if [[ -r /etc/os-release ]]; then
        id="$(. /etc/os-release; echo "${ID:-}")"
        ver="$(. /etc/os-release; echo "${VERSION_ID:-}")"
    fi
    if command -v apt-get >/dev/null 2>&1; then
        ok "${id:-unknown} ${ver:-} — apt 가 있습니다"
    else
        bad "apt 가 없습니다 — 이 스크립트는 데비안 계열 전용입니다"
        PROBLEMS=$((PROBLEMS + 1))
        return
    fi

    step "node"

    local major; major="$(node_major)"
    if [[ "$major" -eq 0 ]]; then
        todo "node 가 없습니다"
    elif [[ "$major" -lt $MIN_MAJOR ]]; then
        bad "node $(node -v) — ${MIN_MAJOR} 이상이 필요합니다 (websocket-relay 가 fetch·AbortSignal.timeout 을 씁니다)"
        PROBLEMS=$((PROBLEMS + 1))
    else
        ok "node $(node -v)"
    fi

    if command -v npm >/dev/null 2>&1; then
        ok "npm $(npm -v) ${DIM}($(dpkg -S "$(command -v npm)" 2>/dev/null | cut -d: -f1 || echo '패키지 밖') 가 제공)${OFF}"
    else
        todo "npm 이 없습니다 ${DIM}(따로 설치하지 마세요 — nodejs 패키지에 들어 있습니다)${OFF}"
    fi

    step "부딪히는 패키지"

    local conflicts; conflicts="$(conflicting_packages)"
    if [[ -z "$conflicts" ]]; then
        ok "없습니다"
    else
        local c
        for c in $conflicts; do
            bad "${c} 가 NodeSource 와 같은 경로를 갖고 있습니다 — 설치가 dpkg 에서 멈춥니다"
        done
        PROBLEMS=$((PROBLEMS + 1))
    fi

    step "NodeSource 저장소"

    if [[ -f "$LIST" ]]; then
        ok "$(basename "$LIST") ${DIM}$(sed -n '1p' "$LIST" | cut -c1-70)${OFF}"
    elif [[ -f "$STALE" ]]; then
        bad "$(basename "$STALE") — dist-upgrade 가 꺼 두었습니다. 업데이트가 오지 않습니다"
        PROBLEMS=$((PROBLEMS + 1))
    else
        todo "저장소가 없습니다"
    fi
    [[ -f "$KEYRING" ]] && ok "키링 있음" || todo "키링 없음"

    if from_nodesource; then
        ok "지금 nodejs 는 NodeSource 것입니다 ${DIM}($(dpkg-query -W -f='${Version}' nodejs))${OFF}"
    elif installed nodejs; then
        todo "지금 nodejs 는 배포판 것입니다 ${DIM}($(dpkg-query -W -f='${Version}' nodejs))${OFF}"
    fi
}

# ── 설치 ─────────────────────────────────────────────────────────────

do_apply() {
    need_root --apply

    step "부딪히는 패키지 치우기"

    local conflicts; conflicts="$(conflicting_packages)"
    if [[ -z "$conflicts" ]]; then
        ok "치울 것이 없습니다"
    else
        echo "  다음이 NodeSource 의 nodejs 와 같은 파일을 갖고 있습니다:"
        echo
        local c
        for c in $conflicts; do echo "      ${c}"; done
        echo
        echo "  ${DIM}지우면 무엇이 함께 나가는지 먼저 봅니다.${OFF}"
        echo
        # 딸려 나가는 것을 보여 준다. 헤더 패키지 하나만 나가는 것이 보통이지만,
        # 그렇지 않은 장비가 있을 수 있어 사람이 보고 정하게 한다.
        apt-get remove -s $conflicts 2>/dev/null | grep -E '^(Remv|REMOVING|다음 패키지)' | sed 's/^/      /' || true
        echo
        if ! confirm "위 패키지를 지우고 계속할까요?"; then
            bad "멈춥니다 — 아무것도 바꾸지 않았습니다"
            exit 1
        fi
        # nodejs 는 여기서 지우지 않는다. 부딪히는 것은 개발 헤더 쪽이고,
        # 런타임을 지우면 그것에 의존하는 패키지가 함께 끌려 나간다.
        run apt-get remove -y $conflicts || { bad "제거 실패"; exit 1; }
    fi

    step "저장소 붙이기"

    run apt-get install -y ca-certificates curl gnupg >/dev/null || { bad "준비 패키지 설치 실패"; exit 1; }

    # 받다가 끊겨도 기존 키링을 깨뜨리지 않도록 임시 파일을 거친다.
    local tmp; tmp="$(mktemp)"
    if ! curl -fsSL "$KEY_URL" | gpg --dearmor > "$tmp" 2>/dev/null || [[ ! -s "$tmp" ]]; then
        rm -f "$tmp"
        bad "키를 받지 못했습니다 — ${KEY_URL} 로 나가는 길을 확인하세요"
        exit 1
    fi
    install -m 0644 "$tmp" "$KEYRING" && rm -f "$tmp"
    ok "키링 ${KEYRING}"

    echo "deb [arch=$(dpkg --print-architecture) signed-by=${KEYRING}] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > "$LIST"
    ok "$(basename "$LIST") — node_${NODE_MAJOR}.x"
    # nodistro 는 오타가 아니다. NodeSource 는 배포판 코드명으로 나누지 않아
    # 22.04 와 24.04 가 같은 줄을 쓴다.

    if [[ -f "$STALE" ]]; then
        # 방금 같은 내용을 살려 두었으므로 꺼진 채 남은 파일은 혼동만 준다.
        rm -f "$STALE"
        ok "$(basename "$STALE") 는 치웠습니다 ${DIM}(위 줄이 대신합니다)${OFF}"
    fi

    step "설치"

    run apt-get update -o Dir::Etc::sourcelist="$LIST" -o Dir::Etc::sourceparts=/dev/null -o APT::Get::List-Cleanup=0 >/dev/null \
        || { bad "저장소를 읽지 못했습니다"; exit 1; }
    run apt-get install -y nodejs || { bad "설치 실패 — 위 dpkg 메시지를 보세요"; exit 1; }

    step "확인"

    hash -r
    local major; major="$(node_major)"
    if [[ "$major" -lt $MIN_MAJOR ]]; then
        bad "설치는 끝났는데 node 가 아직 ${major} 입니다 — PATH 를 확인하세요: $(command -v node)"
        exit 1
    fi
    ok "node $(node -v)"
    command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || bad "npm 이 없습니다 — 예상 밖입니다"

    echo
    echo "  다음:"
    echo "      ${ROOT}/bootstrap.sh"
    echo
}

# ── 되돌리기 ─────────────────────────────────────────────────────────

do_remove() {
    need_root --remove

    step "걷어내기"

    echo "  ${YELLOW}이 저장소의 서비스는 node 20 이상에서만 돕니다.${OFF}"
    echo "  ${DIM}지우면 pm2 로 도는 것들이 다음 재시작에서 뜨지 않습니다.${OFF}"
    echo
    if ! confirm "그래도 걷어낼까요?"; then
        echo "  아무것도 바꾸지 않았습니다"
        exit 0
    fi

    installed nodejs && run apt-get remove -y nodejs
    rm -f "$LIST" "$KEYRING" "$PIN"
    ok "저장소·키링·핀을 지웠습니다"
    echo
    echo "  ${DIM}배포판 node 로 돌아가려면: sudo apt-get install nodejs${OFF}"
    echo "  ${DIM}(그 버전은 12 라 이 저장소의 서비스는 돌지 않습니다)${OFF}"
    echo
}

# ── ─────────────────────────────────────────────────────────────────

case "$MODE" in
    check)
        report
        echo
        if [[ $PROBLEMS -eq 0 ]] && [[ "$(node_major)" -ge $MIN_MAJOR ]]; then
            echo "  ${GREEN}준비됐습니다.${OFF} 바꿀 것이 없습니다."
        elif [[ "$(node_major)" -ge $MIN_MAJOR ]]; then
            # node 자체는 되는데 주변이 어긋난 경우. "설치하세요" 라고 하면
            # 이미 되는 것을 다시 하라는 말로 읽힌다.
            echo "  node 는 됩니다. 위의 ${RED}✗${OFF} 를 고치려면:  ${GREEN}sudo $0 --apply${OFF}"
            echo "  ${DIM}배경은 docs/nodejs-install.md 에 있습니다.${OFF}"
        else
            echo "  설치하려면:  ${GREEN}sudo $0 --apply${OFF}"
            echo "  ${DIM}배경은 docs/nodejs-install.md 에 있습니다.${OFF}"
        fi
        echo
        ;;
    apply)  report; do_apply ;;
    remove) do_remove ;;
esac
