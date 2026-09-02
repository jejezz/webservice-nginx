#!/usr/bin/env bash
#
# 설치본이 저장소 원본과 같은가 — 점검 스크립트들이 함께 쓰는 비교.
#
# 규약은 docs/check-contract.md 의 '설치본이 저장소와 같은가' 절에 있습니다.
#
# ── 왜 필요한가 ─────────────────────────────────────────────────────────
#
# 설정을 저장소에서 고치고 `--apply` 를 잊으면, **어디에도 오류로 보이지
# 않습니다.** 서비스는 옛 설정으로 멀쩡히 돌고 있고 점검은 "떠 있다" 고
# 말합니다. 실제로 그렇게 걸린 적이 있습니다 — /etc/kamailio/kamailio.cfg 에
# wt_timer 가 없어 착신 푸시로 붙들어 둔 INVITE 가 5초에 사라지고 있었는데,
# 그 점검은 훅이 있는지만 grep 으로 보고 있어 통과로 나왔습니다.
#
# 표식(marker)이나 특정 줄을 grep 하는 방식은 **그 줄만** 봅니다. 파일 전체를
# 저장소 원본과 맞춰 보면 그런 어긋남이 한 번에 드러납니다.
#
# ── 자리표시자는 어떻게 하는가 ──────────────────────────────────────────
#
# 설치본은 대개 템플릿을 치환해 만듭니다. 그대로 비교하면 늘 다릅니다.
# 그래서 **키를 기준으로 양쪽을 같은 모양으로 눌러** 비교합니다.
#
#     -n 's/^alias=.*/alias=«/'      템플릿의 alias=__SIP_DOMAIN__ 과
#                                    설치본의 alias=pluto.org 가 같아진다
#     -x 'nat_1_1_mapping'           설치 때 지워질 수 있는 줄은 양쪽에서 뺀다
#
# 값이 맞는지는 이 비교가 보지 않습니다 — 그것은 settings.ini 와
# .applied-settings 를 비교하는 쪽의 일입니다 (docs/settings-contract.md).
# 여기서 보는 것은 **구조가 낡았는가** 입니다.

CONFIG_DIFF_STATE=""     # same | differs | missing | unreadable | no-template
CONFIG_DIFF_COUNT=0      # 다른 줄 수
CONFIG_DIFF_SAMPLE=""    # 처음 몇 줄 (사람이 볼 것)
CONFIG_DIFF_HINT=""      # 어느 쪽이 새것으로 보이는가

# 규칙을 적용해 파일을 표준 모양으로 편다.
_config_render() {
    local file="$1"; shift
    local -a sed_args=()
    local e
    for e in "$@"; do sed_args+=(-e "$e"); done
    if [[ ${#sed_args[@]} -gt 0 ]]; then
        sed "${sed_args[@]}" "$file"
    else
        cat "$file"
    fi
}

# config_diff [-n <sed식>]... [-x <정규식>]... <설치본> <저장소 원본>
#
# 규칙은 **양쪽에 똑같이** 적용한다.
#
# ⚠️ 구분자를 조심할 것. `s|...|...|` 안에서 `\|`(BRE 의 '또는')를 쓰면 구분자와
#    부딪혀 그 식이 조용히 안 먹는다. 실제로 한 번 걸렸다 — 다른 구분자를 쓰자.
#
#        s%^listen=\(udp\|tcp\):.*%listen=\1:«%     ← 이렇게
#
#    -x 의 정규식에도 `/` 를 쓰지 말 것 (내부에서 /re/d 로 만든다).
config_diff() {
    local -a rules=()
    while [[ $# -gt 2 ]]; do
        case "$1" in
            -n) rules+=("$2"); shift 2 ;;
            -x) rules+=("/$2/d"); shift 2 ;;
            *)  break ;;
        esac
    done

    local installed="$1" template="$2"
    CONFIG_DIFF_STATE=""; CONFIG_DIFF_COUNT=0; CONFIG_DIFF_SAMPLE=""; CONFIG_DIFF_HINT=""

    [[ -f "$template" ]]   || { CONFIG_DIFF_STATE="no-template"; return 1; }
    [[ -e "$installed" ]]  || { CONFIG_DIFF_STATE="missing";     return 1; }
    # 읽지 못한 것을 "다르다" 로 보고하면 안 된다 (docs/check-contract.md).
    [[ -r "$installed" ]]  || { CONFIG_DIFF_STATE="unreadable";  return 1; }

    local want have
    want="$(_config_render "$template" "${rules[@]}")"
    have="$(_config_render "$installed" "${rules[@]}")"

    if [[ "$want" == "$have" ]]; then
        CONFIG_DIFF_STATE="same"
        return 0
    fi

    CONFIG_DIFF_STATE="differs"
    local delta
    delta="$(diff <(printf '%s\n' "$want") <(printf '%s\n' "$have") || true)"
    CONFIG_DIFF_COUNT="$(grep -c '^[<>]' <<<"$delta" || true)"

    # ⚠️ **저장소 쪽 줄만 보여 준다.**
    #
    # 설치본에는 비밀이 들어 있다 (DBURL 의 비밀번호, admin_secret 따위).
    # 그 줄을 그대로 찍으면 점검 출력에 비밀이 섞이고, 그 출력은 화면과 JSON 을
    # 타고 나간다. 저장소 원본은 커밋된 파일이므로 자리표시자만 들어 있다.
    #
    # 설치본에만 있는 줄은 개수만 말한다.
    #
    # 어느 쪽 줄인지 **말해 준다.** diff 의 < 만 찍어 놓고 그 밑에 "설치본에만
    # 있는 줄 N개" 를 붙이면, 읽는 사람은 위의 < 줄도 설치본 것으로 읽는다.
    # 실제로 그렇게 읽혔다.
    local sample
    sample="$(grep '^<' <<<"$delta" | head -4)"
    local missing_here
    missing_here="$(grep -c '^<' <<<"$delta" || true)"
    if [[ -n "$sample" ]]; then
        CONFIG_DIFF_SAMPLE="  (저장소에는 있고 설치본에는 없는 줄 ${missing_here}개 — 앞 4개)"
        CONFIG_DIFF_SAMPLE+=$'\n'"$sample"
    fi
    local extra
    extra="$(grep -c '^>' <<<"$delta" || true)"
    [[ "${extra:-0}" -gt 0 ]] && CONFIG_DIFF_SAMPLE+="${CONFIG_DIFF_SAMPLE:+$'\n'}  (설치본에만 있는 줄 ${extra}개 — 비밀이 섞일 수 있어 내용은 찍지 않는다)"

    # 어느 쪽이 새것인지 **추측**한다. git checkout 은 파일 시각을 새로 찍으므로
    # 근거로 삼지 말고 방향 힌트로만 쓴다.
    if [[ "$template" -nt "$installed" ]]; then
        CONFIG_DIFF_HINT="저장소 쪽이 더 새롭습니다"
    else
        CONFIG_DIFF_HINT="설치본이 저장소보다 새롭습니다 — 손으로 고쳤을 수 있습니다"
    fi
    return 1
}

# 점검 규약에 맞춰 한 줄로 보고한다. lib/check-report.sh 를 먼저 source 해야 한다.
#
#   report_config_diff <이름> <적용 명령> [-s <원본을 부를 말 + 조사>] [-n ...] [-x ...] <설치본> <원본>
#
# 판정: 같으면 ok, 다르면 **pending** 이다 — 고장이 아니라 "아직 반영하지
# 않은 것" 이기 때문이다. 읽지 못하면 skip.
#
# 반환값은 "판정에 걸리는 것이 있는가" 다. skip 은 0(문제 없음)이다 —
# 못 본 것을 문제로 세면 sudo 없이 도는 마법사에서 늘 걸린다.
report_config_diff() {
    local label="$1" apply_cmd="$2"; shift 2

    # -s 로 원본을 뭐라고 부를지 바꾼다. 생성되는 파일은 "저장소" 가 아니라
    # "database.ini 로 만든 것" 처럼 부르는 편이 사람에게 정확하다.
    # **조사까지 적는다** — '것와' 가 되지 않게.
    local source_phrase="저장소와"
    if [[ "${1:-}" == "-s" ]]; then source_phrase="$2"; shift 2; fi

    config_diff "$@" && { ok "${label} — ${source_phrase} 같습니다"; return 0; }

    case "$CONFIG_DIFF_STATE" in
        same)        ok   "${label} — ${source_phrase} 같습니다" ;;
        missing)     pend "${label} — 설치되지 않았습니다 → ${apply_cmd}" ;;
        # 못 본 것은 문제가 아니다. 판정에도, 세는 데에도 넣지 않는다.
        unreadable)  skip "${label} — 읽을 수 없어 비교를 건너뜁니다 (권한)"; return 0 ;;
        no-template) warn "${label} — 견줄 원본이 없습니다" ;;
        differs)
            pend "${label} — 설치본이 ${source_phrase} 다릅니다 (${CONFIG_DIFF_COUNT}줄, ${CONFIG_DIFF_HINT}) → ${apply_cmd}"
            # 어디가 다른지 몇 줄 보여 준다. 판정에는 넣지 않는다.
            local line
            while IFS= read -r line; do
                [[ -n "$line" ]] && info "         ${line}"
            done <<<"$CONFIG_DIFF_SAMPLE"
            ;;
    esac
    return 1
}
