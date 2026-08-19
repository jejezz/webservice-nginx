#!/usr/bin/env bash
#
# install_mariadb.sh 와 setup_mariadb.sh 가 공유하는 MariaDB 접속 처리.
#
# 기본은 root의 unix_socket 인증이다. 실패하면 /etc/mysql/debian.cnf 로 한 번 더 시도한다.
#
# 주의: Ubuntu 22.04의 debian.cnf 는 'user = root, 비밀번호 없음'인 폐기 예정 스텁이라
# root 인증이 깨진 상황에서는 도움이 되지 않는다. 예전 레이아웃(debian-sys-maint 자격 증명)을
# 쓰는 배포판을 위해 남겨둔 경로다. 둘 다 실패하면 mariadb_access_help 로 복구 절차를 안내한다.
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

    if _mdb_exec mariadb -N -B -e 'SELECT 1;' &>/dev/null; then
        MARIADB_CRED=()
        MARIADB_CRED_LABEL="root (unix_socket)"
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
