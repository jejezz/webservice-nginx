#!/usr/bin/env bash
#
# [server] 중 **장비마다 다른 값** — 폼이 settings.ini 에 쓰고, 여기가 읽는다.
#
# 규약은 docs/settings-contract.md 입니다. 이 파일은 그 규약의 database 쪽
# 구현이고, 화면 쪽 구현(lib/settings.js)과 **같은 파일**을 읽고 씁니다.
#
# ── 왜 database.ini 에 두지 않는가 ──────────────────────────────────────
#
# `database.ini` 는 **커밋되는 파일**입니다. 그런데 그 안의 몇 값은 그 장비에서
# 정하는 것이고, 파일 자신도 그렇게 적어 두었습니다 — "여는 것은 장비별
# 결정이어야 하고, 이 파일은 어차피 장비마다 다르다".
#
# 두 문장이 부딪힙니다. 장비에서 `bind_address` 를 고치면 다음 `git pull` 과
# 부딪히고, 그것을 커밋하면 한 장비의 결정이 다른 단지로 딸려 갑니다. 다른
# 다섯(site · kamailio · janus · public_ca)은 이미 이 문제를 `settings.ini` 로
# 풀었습니다. 여기만 남아 있었습니다.
#
# ── 값이 정해지는 순서 ──────────────────────────────────────────────────
#
#   1. database/settings.ini      폼이 쓴다 (커밋하지 않는다)
#   2. database.ini 의 [server]   옛 파일에 아직 남아 있다면
#   3. 아래의 기본값              아무도 정하지 않았을 때
#
# 2가 있는 것은 **이사 때문**입니다. 이 규약을 붙이기 전의 장비는 그 값을
# database.ini 에 손으로 적어 두었습니다. 그것을 못 본 척하면, 사람이 아무것도
# 바꾸지 않았는데 다음 실행에서 3306 이 닫히거나 그 반대가 됩니다. 그래서 값을
# 그대로 이어 쓰고, `setup_mariadb.sh` 가 **한 번 settings.ini 로 옮겨 담습니다.**
# 옮기고 나면 2는 비고, 그 뒤로는 폼만 보면 됩니다.
#
# 단독 실행용이 아니라 source 해서 씁니다.

DB_SETTINGS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_SETTINGS_FILE="${DB_SETTINGS_DIR}/settings.ini"
DB_APPLIED_FILE="${DB_SETTINGS_DIR}/.applied-settings"

# 이사 중인 장비를 위한 둘째 자리 (위의 2). 부르는 쪽이 database.ini 를 넣는다.
DB_SETTINGS_FALLBACK_INI="${DB_SETTINGS_DIR}/database.ini"

# 폼이 받는 키와, 아무도 정하지 않았을 때 쓸 값.
#
# ⚠️ 기본값은 `settings-schema.json` 의 `default` 와 **같아야 합니다.** 화면은
#    그쪽을, 이 스크립트들은 이쪽을 읽습니다. bash 가 JSON 을 파싱하게 만드는
#    대신 두 곳에 적는 것은 규약의 다른 서비스들도 그렇게 하고 있습니다
#    (docs/settings-contract.md 의 `settings_get sip_domain 'pluto.org'`).
DB_SETTINGS_KEYS=(bind_address port innodb_buffer_pool_size)
DB_SETTINGS_DEFAULT_bind_address='127.0.0.1'
DB_SETTINGS_DEFAULT_port='3306'
DB_SETTINGS_DEFAULT_innodb_buffer_pool_size='256M'

db_settings_is_managed() {
    local k
    for k in "${DB_SETTINGS_KEYS[@]}"; do [[ "$k" == "$1" ]] && return 0; done
    return 1
}

# settings.ini 에 적힌 값. 없으면 빈 문자열.
#
# `키 = 값` 만 읽습니다 — 절(section)은 쓰지 않습니다. 규약의 다른 settings.ini
# 들도 평평하고, node 쪽(lib/settings.js)도 같은 파일을 그렇게 파싱합니다.
db_settings_saved() {
    local key="$1" v=""
    if [[ -r "$DB_SETTINGS_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$DB_SETTINGS_FILE" | tail -1)"
        v="${v%%[;#]*}"
        v="${v//[[:space:]]/}"
    fi
    printf '%s' "$v"
}

# 옛 database.ini 의 [server] 에 남아 있는 값. 없으면 빈 문자열.
#
# 한 번 훑어 캐시한다. 이 함수는 키마다 불리고, 점검은 마법사가 자주 돌린다.
DB_SETTINGS_LEFTOVER_CACHE=""
db_settings_leftover() {
    local key="$1" line
    if [[ -z "$DB_SETTINGS_LEFTOVER_CACHE" ]]; then
        if [[ -r "$DB_SETTINGS_FALLBACK_INI" ]]; then
            DB_SETTINGS_LEFTOVER_CACHE="$(db_settings_leftovers "$DB_SETTINGS_FALLBACK_INI")"
        fi
        DB_SETTINGS_LEFTOVER_CACHE="${DB_SETTINGS_LEFTOVER_CACHE:-(없음)}"
    fi
    [[ "$DB_SETTINGS_LEFTOVER_CACHE" == "(없음)" ]] && return 0

    while IFS= read -r line; do
        [[ "${line%%=*}" == "$key" ]] && { printf '%s' "${line#*=}"; return 0; }
    done <<< "$DB_SETTINGS_LEFTOVER_CACHE"
    return 0
}

# 실제로 쓰이는 값 = 폼 → 옛 database.ini → 기본값.
db_settings_get() {
    local key="$1" v d="DB_SETTINGS_DEFAULT_$1"
    v="$(db_settings_saved "$key")"
    [[ -z "$v" ]] && v="$(db_settings_leftover "$key")"
    printf '%s' "${v:-${!d-}}"
}

# 마지막으로 반영한 값 (.applied-settings). 없으면 빈 문자열.
db_settings_applied() {
    local key="$1" v=""
    if [[ -r "$DB_APPLIED_FILE" ]]; then
        v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$DB_APPLIED_FILE" | tail -1)"
        v="${v//[[:space:]]/}"
    fi
    printf '%s' "$v"
}

# ── 검증 ────────────────────────────────────────────────────────────────
#
# 화면이 이미 같은 규칙으로 봅니다(settings-schema.json 의 pattern). 그래도 여기서
# 한 번 더 보는 이유는, 사람이 화면을 우회해 파일을 손으로 고칠 수 있기
# 때문입니다 — 규약이 요구하는 두 번째 관문입니다.
#
# 틀린 것을 한 줄씩 표준출력에 적고, 하나라도 있으면 1 을 돌려줍니다.
db_settings_validate() {
    local bad=0 v octet

    v="$(db_settings_get bind_address)"
    if [[ ! "$v" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
        echo "bind_address — IPv4 가 아닙니다: '${v}'"; bad=1
    else
        for octet in ${v//./ }; do
            if [[ "$octet" -gt 255 ]]; then
                echo "bind_address — 각 자리는 255 이하여야 합니다: '${v}'"; bad=1; break
            fi
        done
    fi

    v="$(db_settings_get port)"
    if [[ ! "$v" =~ ^[0-9]+$ ]] || (( v < 1 || v > 65535 )); then
        echo "port — 1~65535 여야 합니다: '${v}'"; bad=1
    fi

    v="$(db_settings_get innodb_buffer_pool_size)"
    if [[ ! "$v" =~ ^[0-9]+[KMGkmg]?$ ]]; then
        echo "innodb_buffer_pool_size — 숫자와 K·M·G 만 씁니다: '${v}'"; bad=1
    fi

    return $bad
}

# ── database.ini 에 남아 있는 것 ────────────────────────────────────────

# [server] 절에 아직 남아 있는 관리 키를 `키=값` 으로 뽑는다.
db_settings_leftovers() {
    local ini="$1"
    sed -n '/^\[server\]/,/^\[/p' "$ini" \
        | sed -n -E 's/^[[:space:]]*([A-Za-z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$/\1=\2/p' \
        | while IFS= read -r pair; do
              pair="${pair%%[;#]*}"
              # if 로 적는다. `A && B` 로 두면 마지막 줄이 관리 키가 아닐 때
              # 반복문 전체가 1 을 돌려주고, set -e 인 곳에서 조용히 죽는다.
              if db_settings_is_managed "${pair%%=*}"; then
                  echo "${pair//[[:space:]]/}"
              fi
          done
}

# 남아 있는 것을 settings.ini 로 **옮겨 담는다.** 그 장비가 손으로 고쳐 둔 값을
# 잃지 않으려는 것이다 — 이 이사에서 조용히 기본값으로 돌아가면, 열어 두기로
# 정했던 3306 이 닫히거나 그 반대가 된다.
#
# 이미 폼에 값이 있으면 건드리지 않는다. 그때는 사람이 나중에 정한 쪽이 맞다.
# root 로 도는 스크립트가 부르므로, 만든 파일의 주인은 저장소의 주인으로 맞춘다
# (화면이 같은 파일을 다시 써야 한다).
#
# 옮긴 키를 한 줄씩 `키=값` 으로 적어 돌려준다. 부르는 쪽이 사람에게 알린다.
db_settings_seed_from_ini() {
    local ini="${1:-$DB_SETTINGS_FALLBACK_INI}" pair key value saved
    local -a added=()

    while IFS= read -r pair; do
        [[ -z "$pair" ]] && continue
        key="${pair%%=*}"; value="${pair#*=}"
        saved="$(db_settings_saved "$key")"
        [[ -n "$saved" ]] && continue
        [[ -z "$value" ]] && continue
        added+=("${key}=${value}")
    done < <(db_settings_leftovers "$ini")

    [[ ${#added[@]} -eq 0 ]] && return 0

    if [[ ! -f "$DB_SETTINGS_FILE" ]]; then
        {
            echo "; database 배포 설정 — 값만 담습니다."
            echo "; 실제 적용은 사람이 아래를 실행해야 일어납니다:"
            echo ";     sudo ./setup_mariadb.sh"
            echo "; 커밋하지 않습니다 — 장비마다 다른 값입니다."
            echo "; 항목의 뜻은 settings-schema.json 에 있습니다."
            echo ""
        } > "$DB_SETTINGS_FILE"
    fi

    for pair in "${added[@]}"; do
        printf '%s = %s\n' "${pair%%=*}" "${pair#*=}" >> "$DB_SETTINGS_FILE"
    done

    chmod 644 "$DB_SETTINGS_FILE"
    chown --reference="$DB_SETTINGS_DIR" "$DB_SETTINGS_FILE" 2>/dev/null || true

    printf '%s\n' "${added[@]}"
}

# ── 99-project.cnf 에 들어갈 옵션 목록 ──────────────────────────────────

# database.ini 의 [server] + 폼이 받은 장비 값.
#
# **설치하는 쪽과 견주는 쪽이 같은 것을 만들어야 한다.** 예전에는 두 스크립트가
# 각자 [server] 를 훑었고, 한쪽만 고치면 점검이 영원히 "다르다" 고 말한다.
#
# 장비 값은 **뒤에** 붙인다. mysqld 는 같은 옵션이 여러 번 오면 뒤엣것을 쓰므로,
# database.ini 에 옛 선언이 남아 있어도 폼 값이 이긴다.
db_server_options() {
    local ini="$1" line section="" key value

    while IFS= read -r line || [[ -n "$line" ]]; do
        line="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<< "$line")"
        [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue

        if [[ "$line" =~ ^\[(.+)\]$ ]]; then
            section="${BASH_REMATCH[1]}"
            continue
        fi

        [[ "$section" == "server" ]] || continue
        [[ "$line" =~ ^([^=]+)=(.*)$ ]] || continue

        key="$(sed 's/[[:space:]]*$//' <<< "${BASH_REMATCH[1]}")"
        db_settings_is_managed "$key" && continue
        value="$(sed 's/^[[:space:]]*//' <<< "${BASH_REMATCH[2]}")"
        printf '%s = %s\n' "$key" "$value"
    done < "$ini"

    for key in "${DB_SETTINGS_KEYS[@]}"; do
        printf '%s = %s\n' "$key" "$(db_settings_get "$key")"
    done
}

# ── 적용 기록 ───────────────────────────────────────────────────────────

# **실제로 설치된 값**을 남긴다. 화면은 settings.ini 와 이것을 비교해 '저장은
# 됐지만 아직 반영 안 됨' 을 알린다 (docs/settings-contract.md).
#
# 되돌렸거나 재시작하지 않았으면 부르지 않는다 — 그때 도는 서버는 옛 값이다.
db_settings_write_applied() {
    local key
    {
        echo "; setup_mariadb.sh 가 마지막으로 반영한 값. 손으로 고치지 마세요."
        for key in "${DB_SETTINGS_KEYS[@]}"; do
            printf '%s = %s\n' "$key" "$(db_settings_get "$key")"
        done
    } > "$DB_APPLIED_FILE"
    chmod 644 "$DB_APPLIED_FILE"
}
