#!/usr/bin/env bash
#
# install_mariadb.sh 와 setup_mariadb.sh 가 공유하는 MariaDB 접속 처리.
#
# 관리자로 붙는 방법이 장비마다 다르다. 아래를 순서대로 시도한다.
#
#   1. 옵션 파일 무시 + 소켓        --no-defaults --protocol=socket -u root
#   2. 기본 옵션 파일               /root/.my.cnf 등이 유효한 경우
#   3. /etc/mysql/debian.cnf        Debian/Ubuntu 유지보수 계정
#   4. 관리자 계정·비밀번호 입력    resolve_mariadb_credentials_interactive 에서만
#
# **1과 2를 나누는 것이 중요하다.** /root/.my.cnf 에 낡은 비밀번호가 들어 있으면
# 옵션 파일을 읽는 순간 "Access denied ... (using password: YES)" 로 실패한다 —
# root 가 멀쩡히 unix_socket 인증인데도 그렇다. 옵션 파일을 무시하고 먼저
# 두드려야 그 상황에서 살아난다.
#
# 주의: Ubuntu 22.04의 debian.cnf 는 'user = root, 비밀번호 없음'인 폐기 예정 스텁이라
# root 인증이 깨진 상황에서는 도움이 되지 않는다. 예전 레이아웃(debian-sys-maint 자격 증명)을
# 쓰는 배포판을 위해 남겨둔 경로다. **그래서 22.04 에서 실질적인 탈출구는 4번이다.**
# 자동으로 되는 것이 하나도 없으면 mariadb_access_help 로 복구 절차를 안내한다.
#
# 1~3 은 사람을 붙잡지 않는다. 점검(check-database.sh)과 상태 표시처럼 조용히
# 돌아야 하는 자리가 이 함수를 쓰기 때문이다. 4번은 그래서 별도 함수로 나눠 두고,
# 설치·설정 스크립트만 그것을 부른다.
#
# 단독 실행용이 아니라 source 해서 쓴다.

DEBIAN_CNF="${DEBIAN_CNF:-/etc/mysql/debian.cnf}"

MARIADB_CRED=()            # 접속에 붙일 인자 (없으면 기본 소켓 인증)
MARIADB_CRED_LABEL=""      # 어떤 자격 증명을 쓰는지 (사람이 읽을 문자열)
MARIADB_CRED_READY=false

# root가 아니면 sudo를 붙인다. -n 이라 비밀번호를 기다리며 멈추지 않는다.
_mdb_exec() {
    local bin="$1"; shift
    if [[ "$(id -u)" -eq 0 ]]; then
        command "$bin" "$@"
    else
        sudo -n "$bin" "$@"
    fi
}

# 쓸 수 있는 자격 증명을 한 번만 찾아 캐시한다. 실패하면 1을 반환.
resolve_mariadb_credentials() {
    $MARIADB_CRED_READY && return 0

    # 1. 옵션 파일을 읽지 않고 소켓으로. 낡은 /root/.my.cnf 를 지나친다.
    if _mdb_exec mariadb --no-defaults --protocol=socket -u root -N -B -e 'SELECT 1;' &>/dev/null; then
        MARIADB_CRED=(--no-defaults --protocol=socket -u root)
        MARIADB_CRED_LABEL="root (unix_socket)"
        MARIADB_CRED_READY=true
        return 0
    fi

    # 2. 옵션 파일에 유효한 자격 증명이 있는 경우 (/root/.my.cnf 등).
    if _mdb_exec mariadb -N -B -e 'SELECT 1;' &>/dev/null; then
        MARIADB_CRED=()
        MARIADB_CRED_LABEL="기본 옵션 파일"
        MARIADB_CRED_READY=true
        return 0
    fi

    if _mdb_exec mariadb --defaults-file="$DEBIAN_CNF" -N -B -e 'SELECT 1;' &>/dev/null; then
        MARIADB_CRED=(--defaults-file="$DEBIAN_CNF")
        MARIADB_CRED_LABEL="debian-sys-maint (${DEBIAN_CNF})"
        MARIADB_CRED_READY=true
        return 0
    fi

    return 1
}

# 자동으로 못 찾으면 사람에게 묻는다.
#
# 자동 경로가 전부 막힌 장비에서의 마지막 탈출구다. root 비밀번호를 모르거나
# /root/.my.cnf 가 낡았어도, 전권을 가진 다른 계정을 알고 있으면 여기서 들어간다.
#
# **부르는 쪽이 root 여야 한다.** 비밀번호는 MYSQL_PWD 로 넘기는데, sudo 는
# 환경을 지우므로 sudo 경유로는 전달되지 않는다. 명령줄에 실어 보내는 것은
# 답이 아니다 — 그러면 같은 장비의 누구에게나 `ps` 로 보인다.
#
# 대화형 터미널이 아니면 묻지 않고 그냥 실패한다. 자동화된 실행이 입력을
# 기다리며 영원히 멈추는 것이 가장 나쁘다.
MARIADB_PROMPT_TRIES="${MARIADB_PROMPT_TRIES:-3}"

resolve_mariadb_credentials_interactive() {
    resolve_mariadb_credentials && return 0

    if [[ ! -t 0 ]]; then
        return 1
    fi

    if [[ "$(id -u)" -ne 0 ]]; then
        echo "  (관리자 계정을 물어보려면 sudo 로 실행해야 합니다)" >&2
        return 1
    fi

    echo "" >&2
    echo "자동으로 접속할 수 있는 관리자 자격 증명을 찾지 못했습니다." >&2
    echo "전권을 가진 계정을 알고 있으면 여기서 입력하세요. (Ctrl-C 로 중단)" >&2

    local i user pw
    for (( i = 1; i <= MARIADB_PROMPT_TRIES; i++ )); do
        read -r -p "  관리자 계정 [root]: " user
        user="${user:-root}"
        read -r -s -p "  '${user}' 비밀번호: " pw; echo >&2

        # 인자가 아니라 환경 변수로 넘긴다. 인자는 프로세스 목록에 남는다.
        export MYSQL_PWD="$pw"
        unset pw

        if _mdb_exec mariadb --no-defaults --protocol=socket -u "$user" -N -B -e 'SELECT 1;' &>/dev/null; then
            MARIADB_CRED=(--no-defaults --protocol=socket -u "$user")
            MARIADB_CRED_LABEL="${user} (직접 입력)"
            MARIADB_CRED_READY=true
            return 0
        fi

        unset MYSQL_PWD
        echo "  접속하지 못했습니다. (${i}/${MARIADB_PROMPT_TRIES})" >&2
    done

    return 1
}

# 결정된 자격 증명으로 클라이언트 실행
mdb()      { _mdb_exec mariadb      "${MARIADB_CRED[@]}" "$@"; }
mdb_dump() { _mdb_exec mariadb-dump "${MARIADB_CRED[@]}" "$@"; }

# 조회 전용. 실패하면 빈 결과.
mdb_query() { mdb -N -B -e "$1" 2>/dev/null || true; }

# 접속이 안 될 때 보여줄 복구 안내
mariadb_access_help() {
    cat <<'EOF'
MariaDB에 접속할 수 없습니다. root@localhost 가 unix_socket 인증을 쓰지 않는 상태로 보입니다.
(서버가 죽은 것과는 다릅니다 — systemctl is-active mariadb 로 먼저 확인하세요.)

전권을 가진 다른 계정을 알고 있다면 아래 복구는 필요 없습니다. setup_mariadb.sh 는
자동 경로가 막히면 계정과 비밀번호를 물어봅니다 (sudo 로, 대화형 터미널에서).

오류 번호로 원인을 구분할 수 있습니다.
  ERROR 1045 ... (using password: NO)   비밀번호 기반 플러그인인데 비밀번호가 없음
  ERROR 1698 ...                        unix_socket 인증인데 OS 사용자가 맞지 않음 (sudo 로 실행)

root 비밀번호를 알고 있다면 그대로 접속해 아래 SQL을 실행하세요.
  mariadb -u root -p

모른다면 --init-file 로 복구합니다. 인증이 열린 채로 방치되는 구간이 없어 이 방법이 안전합니다.
(이 배포판의 유닛은 ExecStart=/usr/sbin/mariadbd $MYSQLD_OPTS 형태라 아래가 동작합니다)

  sudo tee /root/mariadb-fix-root.sql >/dev/null <<'SQL'
  CREATE USER IF NOT EXISTS 'root'@'localhost' IDENTIFIED VIA unix_socket;
  ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket;
  GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;
  FLUSH PRIVILEGES;
  SQL

  sudo systemctl set-environment MYSQLD_OPTS="--init-file=/root/mariadb-fix-root.sql"
  sudo systemctl restart mariadb
  sudo mariadb -e "SELECT CURRENT_USER();"        # root@localhost 확인

  sudo systemctl unset-environment MYSQLD_OPTS    # 원상 복귀 (부팅마다 재실행 방지)
  sudo systemctl restart mariadb
  sudo rm -f /root/mariadb-fix-root.sql

--skip-grant-tables 로 복구할 경우, 반드시 서비스를 먼저 내려야 합니다.
서비스가 떠 있는 채로 두 번째 인스턴스를 띄우면 데이터 디렉토리 잠금 충돌이 납니다.
  ("Can't lock aria control file ... error: 11")
EOF
}
