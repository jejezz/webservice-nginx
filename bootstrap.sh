#!/usr/bin/env bash
#
# 클론한 직후 **처음 한 번** 돌리는 것. 여기서 시작하세요.
#
#   ./bootstrap.sh           준비하고, 구축 마법사를 띄운다
#   ./bootstrap.sh --check   무엇이 준비됐는지 보기만 한다 (아무것도 바꾸지 않음)
#
# ── 이 스크립트가 하는 일과 하지 않는 일 ────────────────────────
# **여기서 하는 것은 "마법사까지 가는 길" 뿐입니다.** 실제 설치(MariaDB·Kamailio·
# Janus·nginx·인증서)는 마법사가 단계별로 안내합니다. 그 편이 나은 이유는,
# 그 일들이 sudo 를 쓰고 장비마다 값이 다르며 순서가 있기 때문입니다 — 한 번에
# 몰아 돌리면 어디서 왜 멈췄는지 알 수 없습니다.
#
# **sudo 를 쓰지 않습니다.** 필요한 자리에서는 무엇을 실행해야 하는지 알려 주고
# 멈춥니다. 이 스크립트가 남의 장비에 root 로 무엇을 했는지 모르는 상태를
# 만들지 않기 위해서입니다.
#
# 여러 번 돌려도 안전합니다.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="run"
for a in "$@"; do
    case "$a" in
        --check) MODE="check" ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "모르는 옵션: $a" >&2; exit 2 ;;
    esac
done

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { echo "  ${GREEN}✓${OFF} $*"; }
todo() { echo "  ${YELLOW}·${OFF} $*"; }
bad()  { echo "  ${RED}✗${OFF} $*"; }
step() { echo; echo "${DIM}──${OFF} $*"; }

PROBLEMS=0

# ── 1. 있어야 하는 것 ────────────────────────────────────────────
step "필요한 도구"

need() {
    local cmd="$1" why="$2" how="$3"
    if command -v "$cmd" >/dev/null 2>&1; then
        ok "${cmd} $(command -v "$cmd" | sed 's|.*/||;s|^|— |') $( "$cmd" --version 2>/dev/null | head -1 | cut -c1-40 )"
    else
        bad "${cmd} 이(가) 없습니다 — ${why}"
        echo "      ${how}"
        PROBLEMS=$((PROBLEMS + 1))
    fi
}

# 배포판 패키지는 22.04 가 12, 24.04 가 18 이라 어느 쪽도 모자랍니다. npm 은 따로
# 설치하지 마세요 — NodeSource 의 nodejs 패키지가 이미 담고 있습니다.
need node "서비스가 node 로 돕니다" "docs/nodejs-install.md 를 보세요 (배포판 apt 로는 안 됩니다)"
need npm  "의존성을 받습니다"        "docs/nodejs-install.md 를 보세요 (nodejs 패키지에 들어 있습니다)"

# node 20 미만이면 릴레이가 뜨지 않는다 (fetch·AbortSignal.timeout 을 쓴다).
if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$major" -lt 20 ]]; then
        bad "node 20 이상이 필요합니다 (지금 ${major}) — websocket-relay 가 fetch 와 AbortSignal.timeout 을 씁니다"
        echo "      docs/nodejs-install.md"
        PROBLEMS=$((PROBLEMS + 1))
    fi
fi

if command -v pm2 >/dev/null 2>&1; then
    ok "pm2 $(pm2 --version 2>/dev/null)"
    HAVE_PM2=1
else
    todo "pm2 가 없습니다 — 서비스를 띄우고 재부팅 뒤 되살리는 데 씁니다"
    echo "      ${ROOT}/pm2/install_pm2.sh install    ${DIM}(sudo 로 전역 설치합니다)${OFF}"
    HAVE_PM2=0
fi

[[ $PROBLEMS -gt 0 ]] && { echo; echo "${RED}먼저 위의 것들을 갖춘 뒤 다시 실행하세요.${OFF}"; exit 1; }

# ── 2. manager 준비 ──────────────────────────────────────────────
#
# 마법사(/manager/setup)가 manager 안에 있다. 그래서 manager 하나만 세우면
# 나머지는 화면을 보며 진행할 수 있다.
step "관리 대시보드(manager) 준비"

if [[ -d "${ROOT}/services/manager/server/node_modules" ]]; then
    ok "server 의존성 있음"
elif [[ "$MODE" == "check" ]]; then
    todo "server 의존성 없음 → 이 스크립트가 npm install 합니다"
else
    echo "  npm install (services/manager/server) …"
    ( cd "${ROOT}/services/manager/server" && npm install --no-audit --no-fund >/dev/null 2>&1 ) \
        && ok "server 의존성 설치됨" \
        || { bad "server 의존성 설치 실패 — 직접 돌려 보세요: cd services/manager/server && npm install"; exit 1; }
fi

# 화면(web)은 빌드 결과를 server/public 으로 낸다. 없으면 대시보드가 빈 화면이다.
if [[ -f "${ROOT}/services/manager/server/public/index.html" ]]; then
    ok "화면 빌드 있음"
elif [[ "$MODE" == "check" ]]; then
    todo "화면 빌드 없음 → 이 스크립트가 빌드합니다"
else
    echo "  npm install + build (services/manager/web) …"
    ( cd "${ROOT}/services/manager/web" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) \
        && ok "화면 빌드됨" \
        || { bad "화면 빌드 실패 — 직접 돌려 보세요: cd services/manager/web && npm install && npm run build"; exit 1; }
fi

# ── 3. 관리자 콘솔 비밀번호 ──────────────────────────────────────
#
# 기본 비밀번호를 두지 않는다. 저장소에 커밋된 비밀번호는 바꾸지 않은 장비
# 전부에서 그대로 통하고, 이 콘솔은 관리자 계정을 만들고 지울 수 있다.
# 그래서 비어 있으면 콘솔이 아예 열리지 않는다(fail-closed).
#
# 대신 그 값을 여기서 받아 둔다 — 그러지 않으면 클론한 사람이 화면 앞에서
# 막히고, 왜 막혔는지 알 길이 없다.
step "관리자 콘솔 비밀번호"

CONFIG="${ROOT}/services/manager/config.json"
EXAMPLE="${ROOT}/services/manager/config.example.json"

set_admin_password() {
    local pw pw2
    while :; do
        read -rsp "  관리자 콘솔 비밀번호 (8자 이상): " pw; echo
        if [[ ${#pw} -lt 8 ]]; then
            bad "8자 이상이어야 합니다."
            continue
        fi
        read -rsp "  한 번 더: " pw2; echo
        if [[ "$pw" != "$pw2" ]]; then
            bad "두 번 입력한 값이 다릅니다."
            continue
        fi
        break
    done

    # 비밀번호를 인자로 넘기지 않는다 — 같은 장비의 다른 사용자에게 ps 목록으로
    # 그대로 보인다. 해시도 argv 대신 환경 변수로 넘긴다.
    local hash
    hash="$(printf '%s' "$pw" | node "${ROOT}/services/manager/server/tools/hash-password.js" --stdin)" \
        || { bad "해시 생성에 실패했습니다."; return 1; }
    unset pw pw2

    MANAGER_PW_HASH="$hash" node -e '
        const fs = require("fs");
        const [example, out] = process.argv.slice(1);
        const c = JSON.parse(fs.readFileSync(example, "utf8"));
        c.superAdmin = { ...c.superAdmin, passwordHash: process.env.MANAGER_PW_HASH };
        delete c.superAdmin.password;
        fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    ' "$EXAMPLE" "$CONFIG" || { bad "config.json 을 쓰지 못했습니다."; return 1; }

    chmod 600 "$CONFIG" 2>/dev/null || true
    ok "config.json 을 만들었습니다 (비밀번호는 해시로만 저장됩니다)"
}

if [[ -f "$CONFIG" ]]; then
    ok "config.json 있음"
elif [[ "$MODE" == "check" ]]; then
    todo "config.json 없음 → 이 스크립트가 비밀번호를 받아 만듭니다"
elif [[ ! -t 0 ]]; then
    # 파이프나 CI 로 돌린 경우. 비밀번호를 물을 수 없다.
    bad "config.json 이 없는데 입력을 받을 수 없습니다 (대화형 터미널이 아닙니다)"
    echo "      cp services/manager/config.example.json services/manager/config.json"
    echo "      cd services/manager/server"
    echo "      printf '%s' '<비밀번호>' | node tools/hash-password.js --stdin"
    echo "      ${DIM}그 값을 config.json 의 superAdmin.passwordHash 에 넣으세요.${OFF}"
    PROBLEMS=$((PROBLEMS + 1))
else
    echo "  ${DIM}관리자 콘솔(로그인 화면의 설정 버튼)로 들어갈 비밀번호입니다."
    echo "  비밀번호는 저장되지 않고 해시만 config.json 에 들어갑니다.${OFF}"
    set_admin_password || PROBLEMS=$((PROBLEMS + 1))
fi

# ── 4. 띄우기 ────────────────────────────────────────────────────
step "manager 기동"

if [[ $HAVE_PM2 -eq 0 ]]; then
    todo "pm2 가 없어 띄우지 못했습니다. 위의 install_pm2.sh 를 먼저 돌리세요."
elif [[ "$MODE" == "check" ]]; then
    pm2 describe manager >/dev/null 2>&1 && ok "이미 떠 있습니다" || todo "아직 떠 있지 않습니다"
else
    if pm2 describe manager >/dev/null 2>&1; then
        pm2 restart manager --update-env >/dev/null 2>&1 && ok "manager 를 다시 띄웠습니다"
    else
        ( cd "${ROOT}/pm2" && pm2 start ecosystem.config.js --only manager >/dev/null 2>&1 ) \
            && { pm2 save >/dev/null 2>&1; ok "manager 를 띄웠습니다"; } \
            || bad "manager 기동 실패 — pm2 logs manager 로 확인하세요"
    fi
fi

# ── 5. 어디로 가야 하나 ──────────────────────────────────────────
step "다음"

PORT="$(sed -n 's/^[[:space:]]*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' \
        "${ROOT}/services/manager/config.example.json" 2>/dev/null | head -1)"
PORT="${PORT:-28084}"

# nginx 는 아직 없을 수 있다. 그때는 포트로 직접 들어가는 길을 알려 준다 —
# 마법사 안에 nginx 반영 단계가 있으므로, 그 전에도 화면은 열려야 한다.
cat <<EOF

  브라우저로 구축 마법사를 여세요.

      ${GREEN}http://127.0.0.1:${PORT}/manager/setup${OFF}
      ${DIM}(nginx 를 이미 반영했다면 https://<이 서버>/manager/setup)${OFF}

  ${YELLOW}처음에는 일반 로그인이 되지 않습니다.${OFF} 관리자 계정은 MariaDB 의
  administrator 테이블에 있는데, ${DIM}그 테이블을 만드는 것이 마법사의 2단계입니다.${OFF}

  로그인 화면의 ${GREEN}설정 버튼(⚙)${OFF} → ${YELLOW}zoomon${OFF} 과 방금 정한 비밀번호
  → 헤더의 ${GREEN}구축 마법사${OFF} 로 들어가세요.
  ${DIM}관리자 콘솔은 config.json 만으로 인증되어 그 고리 밖에 있습니다.
  DB 를 세우고 자기 계정을 만든 뒤부터는 일반 로그인으로 들어가면 됩니다.${OFF}

  마법사가 나머지를 순서대로 안내합니다 — 사이트 값 → DB → pm2 → Kamailio →
  Janus → nginx → 릴레이 → 시험 통화. 각 단계는 무엇을 왜 하는지와 점검 결과를
  함께 보여 주고, sudo 가 필요한 명령은 복사해 쓰도록 보여 주기만 합니다.

EOF

[[ "$MODE" == "check" ]] && echo "  ${DIM}--check 라 아무것도 바꾸지 않았습니다.${OFF}" && echo
exit 0
