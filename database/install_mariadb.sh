#!/usr/bin/env bash
#
# MariaDB 설치 / 업데이트 / 상태 확인 / 제거
#
#   ./install_mariadb.sh install     서버+클라이언트 설치 (기존 설치가 있으면 중단)
#   ./install_mariadb.sh update      설치된 MariaDB 패키지만 업그레이드
#   ./install_mariadb.sh status      버전·서비스·포트·DB 목록 확인
#   ./install_mariadb.sh uninstall   패키지 제거 (데이터는 보존)
#   ./install_mariadb.sh purge       패키지와 데이터까지 삭제 (되돌릴 수 없음)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/backups"
DATA_DIR="/var/lib/mysql"
PACKAGES=(mariadb-server mariadb-client)

# shellcheck source=lib_mariadb.sh
source "${SCRIPT_DIR}/lib_mariadb.sh"

usage() {
    echo "Usage: $0 {install|update|status|uninstall|purge}"
    exit 1
}

is_installed() {
    command -v mariadbd &>/dev/null || dpkg -l mariadb-server 2>/dev/null | grep -q '^ii'
}

server_version() {
    mariadbd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

# 조회 전용 SQL. 자격 증명은 lib_mariadb.sh가 결정한다.
sql() {
    resolve_mariadb_credentials || return 0
    mdb_query "$1"
}

can_query() {
    resolve_mariadb_credentials
}

user_databases() {
    sql "SHOW DATABASES;" | grep -vxE 'information_schema|performance_schema|mysql|sys'
}

require_not_installed() {
    if is_installed; then
        echo "MariaDB가 이미 설치되어 있습니다: $(server_version)"
        echo "업그레이드하려면 '$0 update', 상태 확인은 '$0 status'를 사용하세요."
        exit 1
    fi
}

require_installed() {
    if ! is_installed; then
        echo "MariaDB가 설치되어 있지 않습니다. 먼저 '$0 install'을 실행하세요."
        exit 1
    fi
}

confirm() {
    local prompt="$1" expected="$2" answer
    echo ""
    read -r -p "${prompt} " answer
    if [[ "$answer" != "$expected" ]]; then
        echo "입력이 일치하지 않습니다. 취소합니다."
        exit 1
    fi
}

install_mariadb() {
    echo "=== MariaDB 설치 ==="
    require_not_installed

    sudo apt-get update
    sudo apt-get install -y "${PACKAGES[@]}"

    sudo systemctl enable mariadb
    sudo systemctl start mariadb

    echo ""
    echo "=== 설치 완료: $(server_version) ==="
    echo ""
    echo "다음 단계:"
    echo "  1. database.ini 를 환경에 맞게 수정"
    echo "  2. sudo ./setup_mariadb.sh     # 서버 설정 + DB/사용자 생성"
    echo ""
    echo "root 계정은 unix_socket 인증을 사용합니다. 'sudo mariadb' 로 접속하세요."
}

update_mariadb() {
    echo "=== MariaDB 업데이트 ==="
    require_installed

    local before after
    before="$(server_version)"
    echo "현재 버전: ${before}"

    sudo apt-get update

    local upgradable
    upgradable="$(apt list --upgradable 2>/dev/null | grep -cE '^(mariadb|libmariadb)' || true)"
    if [[ "$upgradable" -eq 0 ]]; then
        echo "업그레이드할 MariaDB 패키지가 없습니다. (현재 ${before})"
        return
    fi

    echo ""
    echo "업그레이드 중 데이터베이스가 잠시 중단됩니다."
    confirm "계속하려면 'yes'를 입력하세요:" "yes"

    sudo apt-get install -y --only-upgrade "${PACKAGES[@]}"

    after="$(server_version)"
    sudo systemctl restart mariadb

    # 메이저/마이너 버전이 올라갔으면 시스템 테이블을 갱신해야 한다.
    if [[ "$before" != "$after" ]]; then
        echo "시스템 테이블 업그레이드: mariadb-upgrade"
        sudo mariadb-upgrade || echo "경고: mariadb-upgrade 실패 — 수동으로 확인하세요."
    fi

    echo ""
    echo "=== 업데이트 완료: ${before} -> ${after} ==="
    systemctl is-active mariadb
}

status_mariadb() {
    echo "=== MariaDB 상태 ==="

    if ! is_installed; then
        echo "설치되어 있지 않습니다."
        exit 0
    fi

    echo "버전       : $(server_version)"
    echo "서비스     : $(systemctl is-active mariadb) / $(systemctl is-enabled mariadb 2>/dev/null || echo '-')"
    echo "데이터 경로: ${DATA_DIR}"

    local listen
    listen="$(ss -ltnp 2>/dev/null | grep -E ':3306|mysqld' | awk '{print $4}' | paste -sd', ' -)"
    echo "리스닝     : ${listen:-'(없음)'}"

    local started
    started="$(systemctl show mariadb --property=ExecMainStartTimestamp --value 2>/dev/null)"
    echo "시작 시각  : ${started:-'-'}"

    echo ""
    echo "--- 설정 파일 ---"
    ls -1 /etc/mysql/mariadb.conf.d/*.cnf 2>/dev/null | sed 's/^/  /'

    if ! can_query; then
        echo ""
        if [[ "$(id -u)" -ne 0 ]]; then
            echo "데이터베이스·사용자 목록은 root 권한이 필요합니다:"
            echo "  sudo $0 status"
        else
            mariadb_access_help
        fi
        return
    fi

    echo ""
    echo "접속 계정  : ${MARIADB_CRED_LABEL}"

    echo ""
    echo "--- 데이터베이스 ---"
    local dbs
    dbs="$(user_databases)"
    if [[ -z "$dbs" ]]; then
        echo "  (사용자 데이터베이스 없음)"
    else
        while IFS= read -r db; do
            local size
            size="$(sql "SELECT IFNULL(ROUND(SUM(data_length+index_length)/1024/1024,1),0) FROM information_schema.tables WHERE table_schema='${db}';")"
            local tables
            tables="$(sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${db}';")"
            printf "  %-24s %6s MB  테이블 %s\n" "$db" "${size:-?}" "${tables:-?}"
        done <<< "$dbs"
    fi

    echo ""
    echo "--- 사용자 ---"
    sql "SELECT CONCAT(user,'@',host) FROM mysql.user ORDER BY user;" | sed 's/^/  /'
}

dump_all() {
    mkdir -p "$BACKUP_DIR"
    local file="${BACKUP_DIR}/all-databases-$(date +%Y%m%d-%H%M%S).sql.gz"

    echo "전체 백업 중: ${file}"
    if ! resolve_mariadb_credentials; then
        rm -f "$file"
        echo "경고: MariaDB에 접속할 수 없어 백업을 건너뜁니다."
        confirm "백업 없이 계속하려면 'continue'를 입력하세요:" "continue"
        return
    fi

    if mdb_dump --all-databases --single-transaction --routines --events 2>/dev/null | gzip > "$file"; then
        echo "백업 완료: $(du -h "$file" | cut -f1)"
    else
        rm -f "$file"
        echo "경고: 백업에 실패했습니다."
        confirm "백업 없이 계속하려면 'continue'를 입력하세요:" "continue"
    fi
}

uninstall_mariadb() {
    echo "=== MariaDB 제거 (데이터 보존) ==="
    require_installed

    local dbs
    dbs="$(user_databases)"
    if [[ -n "$dbs" ]]; then
        echo ""
        echo "사용 중인 데이터베이스가 있습니다:"
        echo "$dbs" | sed 's/^/  - /'
        echo ""
        echo "패키지만 제거하며 ${DATA_DIR} 의 데이터는 남깁니다."
        echo "나중에 다시 설치하면 그대로 사용할 수 있습니다."
    fi

    dump_all
    confirm "제거하려면 'uninstall'을 입력하세요:" "uninstall"

    sudo systemctl stop mariadb || true
    sudo apt-get remove -y "${PACKAGES[@]}"

    echo ""
    echo "=== 제거 완료 (데이터는 ${DATA_DIR} 에 보존됨) ==="
}

purge_mariadb() {
    echo "=== MariaDB 완전 삭제 ==="
    echo ""
    echo "!! 패키지와 함께 ${DATA_DIR} 의 모든 데이터를 삭제합니다. 되돌릴 수 없습니다. !!"

    if is_installed; then
        local dbs
        dbs="$(user_databases)"
        if [[ -n "$dbs" ]]; then
            echo ""
            echo "삭제될 데이터베이스:"
            echo "$dbs" | sed 's/^/  - /'
        fi
        dump_all
    fi

    confirm "정말 삭제하려면 'DELETE ALL DATA'를 그대로 입력하세요:" "DELETE ALL DATA"

    sudo systemctl stop mariadb || true
    sudo apt-get purge -y "${PACKAGES[@]}" mariadb-common
    sudo apt-get autoremove -y
    sudo rm -rf "$DATA_DIR" /etc/mysql

    echo ""
    echo "=== 완전 삭제 완료 ==="
    echo "백업은 ${BACKUP_DIR} 에 남아 있습니다."
}

if [[ $# -ne 1 ]]; then
    usage
fi

case "$1" in
    install)   install_mariadb ;;
    update)    update_mariadb ;;
    status)    status_mariadb ;;
    uninstall) uninstall_mariadb ;;
    purge)     purge_mariadb ;;
    *)         usage ;;
esac
