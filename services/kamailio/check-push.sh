#!/usr/bin/env bash
#
# 인터폰 → 모바일 착신 푸시가 붙을 준비가 됐는지 **확인만** 한다. sudo 가 필요 없다.
#
#   ./check-push.sh          사람이 보는 출력
#   ./check-push.sh --json   기계가 읽는 판정 (docs/check-contract.md)
#
# 흐름과 각 조각의 이유는 docs/incoming-call.md 에 있습니다. 여기서 보는 것은
# 그 흐름의 네 자리입니다.
#
#   ① Kamailio 가 INVITE 를 붙들어 두는가      (tsilo · ts_store/ts_append)
#   ② 붙들어 두는 시간이 얼마인가              (tm wt_timer)
#   ③ 깨우러 갈 상대가 살아 있는가             (rtc-relay-server /health)
#   ④ 깨울 단말을 찾을 수 있는가               (rtc_mobiles.sip_user)
#
# ④ 가 이 흐름에서 가장 자주 비어 있는 자리입니다 — 단말 앱이 /register 에
# sipUser 를 함께 보내야 채워지고, 안 보내면 조용히 아무 일도 일어나지 않습니다.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

INSTALLED_CFG="/etc/kamailio/kamailio.cfg"
LOCAL_CFG="/etc/kamailio/kamailio-local.cfg"
RELAY_HEALTH="${RELAY_HEALTH_URL:-https://127.0.0.1:28099/health}"
FCM_CREDENTIALS="${PROJECT_ROOT}/services/rtc-relay-server/secrets/firebase-admin.json"

DB_NAME="rtc_relay"
DB_USER="jyahn"
DB_PW_FILE="${PROJECT_ROOT}/database/secrets/jyahn.pw"

source "${PROJECT_ROOT}/lib/check-report.sh"

check_init "push.incoming"
check_args "$@"
set -- "${CHECK_REST[@]:-}"

for arg in "$@"; do
    case "$arg" in
        --check) ;;             # 이 스크립트는 확인만 한다
        "") ;;                  # check_args 가 비운 자리
        *) echo "Unknown option: $arg" >&2
           echo "Usage: $0 [--check] [--json]" >&2; exit 1 ;;
    esac
done

db_query() {
    [[ -r "$DB_PW_FILE" ]] || return 1
    MYSQL_PWD="$(head -1 "$DB_PW_FILE" | tr -d '\r\n')" \
        mariadb -h 127.0.0.1 -u "$DB_USER" -N -B -e "$1" 2>/dev/null
}

# ---------- ① 붙들어 두는가 ----------

info "Kamailio — INVITE 를 붙들어 두는 자리"

if [[ -r "$INSTALLED_CFG" ]]; then
    missing=()
    grep -q 'loadmodule "tsilo.so"' "$INSTALLED_CFG" || missing+=("tsilo 모듈")
    grep -q 'ts_store'               "$INSTALLED_CFG" || missing+=("ts_store — 붙들어 두기")
    grep -q 'ts_append'              "$INSTALLED_CFG" || missing+=("ts_append — 등록되면 이어 주기")

    if [[ ${#missing[@]} -eq 0 ]]; then
        ok "착신 푸시 훅이 설치돼 있습니다 (tsilo · ts_store · ts_append)"
    else
        pend "설치본에 없는 것: ${missing[*]} → sudo services/kamailio/install.sh --apply"
    fi
else
    skip "${INSTALLED_CFG} 를 읽을 수 없어 확인을 건너뜁니다"
fi

# ---------- ② 얼마나 붙들어 두는가 ----------

if [[ -r "$INSTALLED_CFG" ]]; then
    wt="$(sed -n 's/^modparam("tm", *"wt_timer", *\([0-9]*\)).*/\1/p' "$INSTALLED_CFG" | head -1)"
    if [[ -n "$wt" ]]; then
        # 이 값이 곧 "단말이 깨어나 REGISTER 할 때까지 기다려 주는 시간" 이다.
        ok "붙들어 두는 시간: $((wt / 1000))초 (tm wt_timer = ${wt}ms)"
    else
        # 훅은 있는데 이 값만 없다면 설치본이 저장소보다 낡은 것이다.
        pend "wt_timer 가 설치본에 없습니다 — 붙들어 둔 INVITE 가 기본값 5초에 사라져 FCM 왕복(2~8초)을 못 기다립니다 → sudo services/kamailio/install.sh --apply"
    fi
fi

if [[ -r "$LOCAL_CFG" ]]; then
    if grep -q 'SIP_PUSH_URL' "$LOCAL_CFG"; then
        ok "푸시 요청 주소(SIP_PUSH_URL)가 설정에 있습니다"
    else
        pend "SIP_PUSH_URL 이 없습니다 → sudo services/kamailio/install.sh --apply"
    fi
else
    # root 전용 파일이다. 못 본 것이지 잘못된 것이 아니다 (docs/check-contract.md).
    skip "${LOCAL_CFG} 는 root 만 읽을 수 있어 확인을 건너뜁니다 (sudo 로 실행해 보세요)"
fi

# ---------- ③ 깨우러 갈 상대 ----------

info ""
info "rtc-relay-server — 깨우는 쪽"

code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "$RELAY_HEALTH" 2>/dev/null || true)"
case "${code:-000}" in
    200) ok "살아 있습니다: ${RELAY_HEALTH} → 200" ;;
    000) warn "응답이 없습니다: ${RELAY_HEALTH} — pm2 restart rtc-relay-server" ;;
    *)   warn "${RELAY_HEALTH} → ${code}" ;;
esac

if [[ -r "$FCM_CREDENTIALS" ]]; then
    ok "FCM 자격 증명: $(basename "$FCM_CREDENTIALS") (권한 $(stat -c '%a' "$FCM_CREDENTIALS"))"
elif [[ -e "$FCM_CREDENTIALS" ]]; then
    skip "FCM 자격 증명을 읽을 수 없습니다 (권한): ${FCM_CREDENTIALS}"
else
    pend "FCM 자격 증명이 없습니다: ${FCM_CREDENTIALS} — 이것이 없으면 단말을 깨우지 못합니다"
fi

# ---------- ④ 깨울 단말을 찾을 수 있는가 ----------

info ""
info "단말 매핑 — SIP 내선으로 토큰을 찾는 자리"

if ! [[ -r "$DB_PW_FILE" ]]; then
    skip "DB 비밀번호 파일을 읽을 수 없어 확인을 건너뜁니다: ${DB_PW_FILE}"
elif ! command -v mariadb >/dev/null 2>&1; then
    skip "mariadb 클라이언트가 없어 확인을 건너뜁니다"
else
    has_column="$(db_query "SELECT COUNT(*) FROM information_schema.columns
                            WHERE table_schema='${DB_NAME}' AND table_name='rtc_mobiles'
                              AND column_name='sip_user';" || true)"

    if [[ "${has_column:-0}" -gt 0 ]]; then
        ok "rtc_mobiles.sip_user 컬럼 있음 (schema/002-sip-user.sql 적용됨)"

        mapped="$(db_query "SELECT COUNT(*) FROM ${DB_NAME}.rtc_mobiles
                            WHERE sip_user IS NOT NULL AND sip_user <> '';" || true)"
        total="$(db_query "SELECT COUNT(*) FROM ${DB_NAME}.rtc_mobiles;" || true)"

        if [[ "${mapped:-0}" -gt 0 ]]; then
            ok "SIP 내선이 연결된 단말: ${mapped}대 (등록 단말 ${total:-0}대)"
        else
            pend "SIP 내선이 연결된 단말이 없습니다 (등록 단말 ${total:-0}대) — 앱이 /register 에 sipUser 를 함께 보내야 합니다"
        fi
    elif [[ -z "$has_column" ]]; then
        skip "${DB_NAME} 에 접속하지 못해 확인을 건너뜁니다"
    else
        pend "rtc_mobiles.sip_user 컬럼이 없습니다 → sudo database/setup_mariadb.sh"
    fi
fi

check_finish

echo ""
echo "실제로 걸어 보는 것은 이 스크립트가 하지 않습니다 — 인터폰에서 내선으로 걸어 보세요."
