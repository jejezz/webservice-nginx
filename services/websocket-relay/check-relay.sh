#!/usr/bin/env bash
#
# websocket-relay 가 붙을 준비가 됐는지 확인한다. **아무것도 고치지 않는다.**
#
#   ./check-relay.sh              사람이 보는 출력 (npm run doctor 와 같다)
#   ./check-relay.sh --check --json   구축 마법사용 (docs/check-contract.md)
#
# ── 왜 셸 껍데기가 하나 더 있나 ──────────────────────────────────
# 실제 점검은 scripts/doctor.ts 가 한다. 그런데 그 파일은 tsx 로 도는데,
# tsx 는 node_modules 안에 있다. **아직 npm install 을 안 한 장비에서는
# 점검 자체가 실행되지 않는다.**
#
# 그대로 두면 마법사는 "점검 스크립트를 실행할 수 없습니다 (ENOENT)" 라고만
# 말한다. 그것은 사실이지만 사람이 무엇을 해야 하는지는 알려 주지 않는다.
# 이 껍데기가 그 한 경우를 셸에서 먼저 잡아 "npm install 을 하세요" 로
# 바꿔 준다. 나머지는 전부 doctor 에게 넘긴다.
#
# 마법사가 이 파일을 부르는 또 하나의 이유: setup.js 의 실행기는 셸 스크립트와
# node 만 알고 tsx 는 모른다 (services/setup.js 의 resolveCheck).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TSX="${SCRIPT_DIR}/node_modules/.bin/tsx"
DOCTOR="scripts/doctor.ts"

source "${REPO_ROOT}/lib/check-report.sh"
check_init "relay.service"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

PASS=()
for a in "$@"; do
    case "$a" in
        --check) PASS+=(--check) ;;
        "") ;;
        -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done
[[ $CHECK_JSON -eq 1 ]] && PASS+=(--json)

# 점검을 돌릴 수조차 없는 경우. 여기서만 우리가 직접 보고한다.
if [[ ! -x "$TSX" ]]; then
    pend "node_modules 가 없어 점검을 돌릴 수 없습니다 → cd services/websocket-relay && npm install"
    check_finish
    echo
    echo "npm install 뒤에 다시 실행하세요."
    exit 1
fi

# 나머지는 전부 doctor 가 본다. exec 로 넘겨 종료 코드까지 그대로 나가게 한다.
cd "$SCRIPT_DIR" || exit 1
exec "$TSX" "$DOCTOR" "${PASS[@]:-}"
