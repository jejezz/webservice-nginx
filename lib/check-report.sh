#!/usr/bin/env bash
#
# 점검 결과를 사람과 기계 양쪽에 내보내는 공용 함수들.
#
# 규약은 docs/check-contract.md 에 있습니다. 이 파일은 그 구현입니다.
#
# ── 쓰는 법 ────────────────────────────────────────────────────────────
#
#     source "${SCRIPT_DIR}/../../lib/check-report.sh"
#     check_init "janus.config"        # 이 점검이 무엇을 보는지 (단계 id)
#     check_args "$@"                  # --json 을 걸러낸다
#
#     ok    "바이너리 있음"
#     pend  "secrets/ 없음 — install.sh --apply 를 돌리세요"
#     skip  "settings.ini 없음 — LAN 전용으로 설치됩니다"
#     warn  "Kamailio 가 떠 있지 않습니다"
#     info  "제목 줄"                   # 판정에 들어가지 않는 안내
#
#     check_finish                     # JSON 이면 여기서 출력하고 종료
#
# ── 왜 종료 코드가 아니라 이것인가 ──────────────────────────────────────
#
# 기존 점검 스크립트들은 문제가 있어도 종료 코드 0 을 냅니다. 그 자체로는
# 틀리지 않습니다 — "점검을 정상적으로 마쳤다" 는 뜻이지 "모두 갖춰졌다" 가
# 아니기 때문입니다. 그래서 화면이 판정을 읽으려면 별도의 통로가 필요합니다.
#
# 또 하나. 지금까지 `[--]` 하나가 두 가지를 뜻했습니다.
#
#     [--]  settings.ini 없음 — LAN 전용으로 설치됩니다     ← 안 해도 되는 것
#     [--]  secrets/ 없음 — 아직 --apply 를 안 돌렸습니다   ← 아직 안 한 것
#
# 앞은 통과여야 하고 뒤는 막아야 하는데, 텍스트로는 구분할 수 없습니다.
# 그래서 `skip` 과 `pend` 로 쪼갭니다. **사람이 보는 출력은 둘 다 `[--]` 로
# 그대로 둡니다** — 터미널에서 쓰던 사람의 눈에는 달라지는 것이 없습니다.

CHECK_JSON=0
CHECK_STEP=""
# level|text 를 담는다. 구분자로 파이프를 쓰므로 본문의 파이프는 바꿔 넣는다.
CHECK_ENTRIES=()

check_init() { CHECK_STEP="${1:-}"; }

# 인자 목록에서 --json 을 걸러낸다. 남은 인자를 CHECK_REST 에 담는다.
#
#     check_args "$@"
#     set -- "${CHECK_REST[@]}"
#
CHECK_REST=()
check_args() {
    CHECK_REST=()
    local a
    for a in "$@"; do
        case "$a" in
            --json) CHECK_JSON=1 ;;
            *) CHECK_REST+=("$a") ;;
        esac
    done
}

_check_add() {
    local level="$1"; shift
    local text="$*"
    text="${text//|/ }"          # 구분자와 충돌하지 않게
    CHECK_ENTRIES+=("${level}|${text}")
}

# 사람이 보는 출력은 예전 그대로다. JSON 모드일 때만 조용해진다.
ok()   { _check_add ok      "$*"; [[ $CHECK_JSON -eq 1 ]] || echo "  [ok]   $*"; }
pend() { _check_add pending "$*"; [[ $CHECK_JSON -eq 1 ]] || echo "  [--]   $*"; }
skip() { _check_add skip    "$*"; [[ $CHECK_JSON -eq 1 ]] || echo "  [--]   $*"; }
warn() { _check_add problem "$*"; [[ $CHECK_JSON -eq 1 ]] || echo "  [!!]   $*"; }
# 제목·설명처럼 판정에 들어가지 않는 줄. JSON 에는 담지 않는다.
info() { [[ $CHECK_JSON -eq 1 ]] || echo "$*"; }

# JSON 문자열 이스케이프. 제어문자까지 다루지는 않는다 — 점검 문구에 들어올
# 일이 없고, 들어오면 그건 고쳐야 할 문구다.
_check_esc() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    echo "$s"
}

# 판정. problem 이 하나라도 있으면 problem, 아니면 pending 이 있으면 incomplete,
# 둘 다 없으면 complete. skip 은 판정에 영향을 주지 않는다.
check_state() {
    local e level
    local has_pending=0
    for e in "${CHECK_ENTRIES[@]:-}"; do
        level="${e%%|*}"
        [[ "$level" == "problem" ]] && { echo "problem"; return 0; }
        [[ "$level" == "pending" ]] && has_pending=1
    done
    [[ $has_pending -eq 1 ]] && { echo "incomplete"; return 0; }
    echo "complete"
}

# JSON 모드면 결과를 찍고 **그 자리에서 종료**한다. 아니면 아무것도 하지 않는다.
#
# 종료 코드는 판정을 따른다 — complete 0, 그 밖에는 1. 사람이 보는 모드의
# 종료 코드는 바꾸지 않는다 (기존 습관을 깨지 않기 위해서다).
check_finish() {
    [[ $CHECK_JSON -eq 1 ]] || return 0

    local state; state="$(check_state)"
    printf '{\n  "step": "%s",\n  "state": "%s",\n  "checks": [\n' \
        "$(_check_esc "$CHECK_STEP")" "$state"

    local i=0 total="${#CHECK_ENTRIES[@]}" e level text
    for e in "${CHECK_ENTRIES[@]:-}"; do
        level="${e%%|*}"
        text="${e#*|}"
        i=$((i + 1))
        printf '    { "level": "%s", "text": "%s" }%s\n' \
            "$level" "$(_check_esc "$text")" \
            "$([[ $i -lt $total ]] && echo ',' || echo '')"
    done

    printf '  ]\n}\n'
    [[ "$state" == "complete" ]] && exit 0 || exit 1
}
