#!/usr/bin/env bash
#
# 사이트 값 읽기 — **여러 서비스가 함께 쓰는 것들** (site/settings.ini).
#
#   source "${REPO_ROOT}/lib/site.sh"
#   SIP_DOMAIN="$(settings_get sip_domain "$(site_get sip_domain 'pluto.org')")"
#
# ── 왜 있는가 ────────────────────────────────────────────────────
# 설정 규약(docs/settings-contract.md)의 단위는 서비스 하나다. 그래서 host 나
# sip_domain 처럼 여럿이 쓰는 값은 각자 자기 settings.ini 에 베껴 적혔고,
# 어긋나도 아무도 몰랐다 (site/README.md 에 실제 사고가 적혀 있다).
#
# ── 우선순위 ─────────────────────────────────────────────────────
# **서비스 값이 이긴다.** 사이트 값은 그것이 비어 있을 때만 쓰인다. 한 장비만
# 다르게 두어야 하는 경우를 막지 않기 위해서다. 위의 관용구가 그 순서다 —
# `settings_get` 의 fallback 자리에 `site_get` 을 넣는다.
#
# 파일이 없으면 조용히 기본값으로 간다. 이 층을 아직 만들지 않은 배치가 그대로
# 동작해야 한다.

# 이 파일이 있는 곳의 부모가 저장소 뿌리다.
_SITE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_SETTINGS_FILE="${SITE_SETTINGS_FILE:-$(cd "${_SITE_LIB_DIR}/.." && pwd)/site/settings.ini}"

# `키 = 값` 만 읽는다. 섹션은 쓰지 않는다 (site/apply.sh · libs/siteSettings.ts 와 같은 규칙).
site_get() {
    local key="$1" fallback="${2:-}" v=""
    if [[ -r "$SITE_SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$SITE_SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
    fi
    v="${v//[[:space:]]/}"
    echo "${v:-$fallback}"
}
