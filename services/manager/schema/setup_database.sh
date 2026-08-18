#!/usr/bin/env bash
#
# manager 스키마를 만들고 이 디렉토리의 *.sql 을 이름순으로 적용한다.
# 여러 번 실행해도 안전하다. (모든 SQL이 IF NOT EXISTS 를 쓴다)
#
#   sudo ./schema/setup_database.sh
#   sudo ./schema/setup_database.sh --db manager --user jyahn
#
# DB 관리자로 붙어야 하므로 root 로 실행한다.
#
# 붙는 방법은 서버마다 다르다. root 가 unix_socket 인증일 수도 있고, 비밀번호
# 인증일 수도 있다. /root/.my.cnf 가 있으면 mysql 이 거기 적힌 비밀번호를 자동으로
# 보내는데, 그 값이 낡았으면 "Access denied ... (using password: YES)" 로 실패한다.
# 그래서 아래 네 가지를 순서대로 시도한다.
#   1. 옵션 파일 무시 + 소켓 (unix_socket 인증인 경우)
#   2. 기본 옵션 파일 (/root/.my.cnf 등이 유효한 경우)
#   3. /etc/mysql/debian.cnf (Debian/Ubuntu 유지보수 계정)
#   4. 관리자 계정·비밀번호 직접 입력
# 애플리케이션 계정의 비밀번호는 화면에 입력받아 config.json 의
# database.passwordFile(기본 manager/secrets/manager-db.pw)에 0600으로 저장한다.
set -euo pipefail

SCHEMA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_DIR="$(cd "${SCHEMA_DIR}/.." && pwd)"

DB_NAME="manager"
DB_USER="jyahn"
DB_HOST="127.0.0.1"
PASSWORD_FILE="${MANAGER_DIR}/secrets/manager-db.pw"

usage() {
  cat <<'EOF'
Usage: sudo ./schema/setup_database.sh [options]

Options:
  --db NAME          Schema name (default: manager).
  --user NAME        Application DB user (default: jyahn).
  --host HOST        Host the user connects from (default: 127.0.0.1).
  --password-file P  Where to store the password (default: ../secrets/manager-db.pw).
  -h, --help         Show this help message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_NAME="${2:?}"; shift 2 ;;
    --user) DB_USER="${2:?}"; shift 2 ;;
    --host) DB_HOST="${2:?}"; shift 2 ;;
    --password-file) PASSWORD_FILE="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ $(id -u) -ne 0 ]]; then
  echo "root 로 실행하세요: sudo $0" >&2
  exit 1
fi

if ! command -v mysql >/dev/null 2>&1; then
  echo "mysql 클라이언트를 찾을 수 없습니다. MariaDB 를 먼저 설치하세요." >&2
  exit 1
fi

# 관리자로 어떻게 붙을지 먼저 정한다. 비밀번호를 입력받기 전에 실패해야
# 사용자가 헛되이 비밀번호를 두 번 치지 않는다.
ADMIN_ARGS=()

if mysql --no-defaults --protocol=socket -u root -e 'SELECT 1' >/dev/null 2>&1; then
  ADMIN_ARGS=(--no-defaults --protocol=socket -u root)
  echo "관리자 연결: unix_socket (root)"
elif mysql -e 'SELECT 1' >/dev/null 2>&1; then
  # 옵션 파일(/root/.my.cnf 등)에 유효한 자격 증명이 있는 경우.
  echo "관리자 연결: 기본 옵션 파일"
elif [[ -r /etc/mysql/debian.cnf ]] \
  && mysql --defaults-file=/etc/mysql/debian.cnf -e 'SELECT 1' >/dev/null 2>&1; then
  # Debian/Ubuntu 의 유지보수 계정(debian-sys-maint). 대개 전권을 가지고 있어서
  # root 비밀번호를 모르거나 /root/.my.cnf 가 낡았을 때의 탈출구가 된다.
  ADMIN_ARGS=(--defaults-file=/etc/mysql/debian.cnf)
  echo "관리자 연결: /etc/mysql/debian.cnf (debian-sys-maint)"
else
  echo "root 로 접속하지 못했습니다. 관리자 계정을 입력하세요." >&2
  read -r -p "관리자 계정 [root]: " ADMIN_USER
  ADMIN_USER="${ADMIN_USER:-root}"
  read -r -s -p "'${ADMIN_USER}' 비밀번호: " ADMIN_PASSWORD; echo
  # 인자로 넘기면 프로세스 목록에 남으므로 환경변수로 전달한다.
  export MYSQL_PWD="$ADMIN_PASSWORD"
  ADMIN_ARGS=(--no-defaults --protocol=socket -u "$ADMIN_USER")
  if ! mysql "${ADMIN_ARGS[@]}" -e 'SELECT 1' >/dev/null 2>&1; then
    echo "관리자 접속에 실패했습니다." >&2
    exit 1
  fi
fi

# 애플리케이션 계정 비밀번호는 인자로 받지 않는다. (프로세스 목록과 셸 히스토리에 남는다)
if [[ -f "$PASSWORD_FILE" ]]; then
  echo "기존 비밀번호 파일을 사용합니다: ${PASSWORD_FILE}"
  DB_PASSWORD="$(head -n1 "$PASSWORD_FILE")"
else
  read -r -s -p "'${DB_USER}' 계정에 사용할 비밀번호: " DB_PASSWORD; echo
  read -r -s -p "다시 입력: " DB_PASSWORD_CONFIRM; echo
  if [[ "$DB_PASSWORD" != "$DB_PASSWORD_CONFIRM" ]]; then
    echo "비밀번호가 일치하지 않습니다." >&2
    exit 1
  fi
  if [[ -z "$DB_PASSWORD" ]]; then
    echo "비밀번호를 비워 둘 수 없습니다." >&2
    exit 1
  fi
  # 아래에서 SQL 문자열 리터럴에 그대로 넣으므로, 따옴표나 백슬래시가 들어가면
  # 구문이 깨진다. 조용히 이상하게 만들기보다 여기서 분명히 막는다.
  if [[ "$DB_PASSWORD" == *"'"* || "$DB_PASSWORD" == *'\'* ]]; then
    echo "비밀번호에 작은따옴표(')나 백슬래시(\\)는 쓸 수 없습니다." >&2
    exit 1
  fi
fi

echo "스키마 ${DB_NAME} 와 계정 ${DB_USER}@${DB_HOST} 를 준비합니다."

# 비밀번호를 인자로 넘기지 않도록 표준 입력으로 전달한다.
mysql "${ADMIN_ARGS[@]}" --batch <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'${DB_HOST}' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'${DB_HOST}' IDENTIFIED BY '${DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB_NAME}\`.* TO '${DB_USER}'@'${DB_HOST}';
FLUSH PRIVILEGES;
SQL

shopt -s nullglob
for sql in "$SCHEMA_DIR"/[0-9]*.sql; do
  echo "적용: $(basename "$sql")"
  mysql "${ADMIN_ARGS[@]}" --batch "$DB_NAME" < "$sql"
done
shopt -u nullglob

mkdir -p "$(dirname "$PASSWORD_FILE")"
printf '%s\n' "$DB_PASSWORD" > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"

# manager 를 실행할 계정이 읽을 수 있어야 한다. sudo 로 실행됐다면 원래 사용자에게 넘긴다.
if [[ -n "${SUDO_USER:-}" ]]; then
  chown "$SUDO_USER" "$PASSWORD_FILE" "$(dirname "$PASSWORD_FILE")"
fi

echo "완료. 비밀번호 파일: ${PASSWORD_FILE}"
echo "config.json 의 database 항목이 이 값과 맞는지 확인하세요."
