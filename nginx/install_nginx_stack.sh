#!/usr/bin/env bash
#
# Nginx 설치 + 설정 생성 + reload.
#
# 라우팅은 이 스크립트가 알지 않는다. 각 서비스가 자기 디렉토리의
# nginx-conf/*.ini 에 포트와 라우트를 선언하고, generate_nginx_conf.py 가
# 그것을 모아 설정 파일을 만든다. 스키마는 ../docs/nginx-conf.md 참고.
#
# 프로세스 기동은 pm2 가 담당한다. (../pm2/ecosystem.config.js)
# 이 스크립트는 설정만 만든다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/nginx-stack.conf"

SERVICES_DIR="${SCRIPT_DIR}/../services"
GENERATOR="${SCRIPT_DIR}/generate_nginx_conf.py"
CONFIG_TEMPLATE_PATH="${SCRIPT_DIR}/nginx/server.conf.template"
CONFIG_DEST="/etc/nginx/conf.d/path-routing.conf"

LISTEN_PORT=80
SSL_PORT=443
MAX_BODY=100m

CERT_TARGET_DIR="/etc/nginx/certs"
SSL_CERT_PATH=""
SSL_KEY_PATH=""
# resolve_cert_paths 가 찾아낸 원본. dry-run 검증에 쓴다.
SRC_CERT_PATH=""
SRC_KEY_PATH=""
TLS_CERT_DIR=""
TLS_CERT_FILE=""
TLS_KEY_FILE=""

SKIP_INSTALL=0
SKIP_RELOAD=0
CHECK_ONLY=0
DRY_RUN=0

# 설정을 임시 파일에 먼저 쓴 뒤 옮기므로, 어떤 경로로 끝나든 지워야 한다.
# RETURN 트랩은 쓰지 않는다 — set -T 없이는 전역에 남아서 다음 함수가
# 반환할 때 또 발동하고, 그때는 변수가 스코프 밖이라 set -u 에 걸린다.
STAGED_CONFIG=""

cleanup_staged() {
  if [[ -n "$STAGED_CONFIG" ]]; then
    rm -f "$STAGED_CONFIG"
  fi
}

trap cleanup_staged EXIT

usage() {
  cat <<'EOF'
Usage: ./install_nginx_stack.sh [options]

Routes are not defined here — each service declares its own ports and routes in
services/<name>/nginx-conf/*.ini. See docs/nginx-conf.md.

Options:
  --config PATH          Path to a config file (default: ./nginx-stack.conf).
  --services-dir PATH    Directory to scan for nginx-conf/ (default: ../services).
  --listen-port PORT     Plain HTTP port, redirects to HTTPS (default: 80).
  --ssl-port PORT        HTTPS port (default: 443).
  --max-body SIZE        Default client_max_body_size (default: 100m).
  --check                Parse service declarations, report conflicts, then stop.
  --skip-install         Skip installing NGINX packages.
  --skip-reload          Skip the NGINX reload step.
  --dry-run              Print the actions that would be taken without running them.
  -h, --help             Show this help message.
EOF
}

load_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    return 0
  fi

  echo "Loading config from ${CONFIG_FILE}"
  local section=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#${line%%[![:space:]]*}}"
    line="${line%${line##*[![:space:]]}}"

    if [[ -z "$line" || "$line" =~ ^# || "$line" =~ ^\; ]]; then
      continue
    fi

    if [[ "$line" =~ ^\[([^]]+)\]$ ]]; then
      section="${BASH_REMATCH[1]}"
      continue
    fi

    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key//[[:space:]]/}"
    value="${value# }"

    case "$section:$key" in
      general:listen_port)  LISTEN_PORT="$value" ;;
      general:ssl_port)     SSL_PORT="$value" ;;
      general:max_body)     MAX_BODY="$value" ;;
      general:services_dir) SERVICES_DIR="${SCRIPT_DIR}/${value}" ;;
      general:skip_install) SKIP_INSTALL="$value" ;;
      general:skip_reload)  SKIP_RELOAD="$value" ;;
      tls:cert_dir)         TLS_CERT_DIR="$value" ;;
      tls:cert_file)        TLS_CERT_FILE="$value" ;;
      tls:key_file)         TLS_KEY_FILE="$value" ;;
      tls:cert_path)        SSL_CERT_PATH="$value" ;;
      tls:key_path)         SSL_KEY_PATH="$value" ;;
    esac
  done < "$CONFIG_FILE"
}

# 명령행 인자가 설정 파일을 이긴다. 그래서 파일을 먼저 읽고 인자를 나중에 적용한다.
load_config

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)        CONFIG_FILE="${2:?}"; load_config; shift 2 ;;
    --services-dir)  SERVICES_DIR="${2:?}"; shift 2 ;;
    --listen-port)   LISTEN_PORT="${2:?}"; shift 2 ;;
    --ssl-port)      SSL_PORT="${2:?}"; shift 2 ;;
    --max-body)      MAX_BODY="${2:?}"; shift 2 ;;
    --check)         CHECK_ONLY=1; shift ;;
    --skip-install)  SKIP_INSTALL=1; shift ;;
    --skip-reload)   SKIP_RELOAD=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run enabled; no changes will be made."
fi

ensure_root_or_sudo() {
  if [[ $(id -u) -eq 0 ]]; then
    echo ""
  elif command -v sudo >/dev/null 2>&1; then
    echo "sudo"
  else
    echo "Please run as root or install sudo." >&2
    exit 1
  fi
}

run_privileged() {
  local sudo_cmd
  sudo_cmd="$(ensure_root_or_sudo)"
  if [[ -n "$sudo_cmd" ]]; then
    "$sudo_cmd" "$@"
  else
    "$@"
  fi
}

require_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to generate the nginx config." >&2
    exit 1
  fi
  if [[ ! -f "$GENERATOR" ]]; then
    echo "Generator not found: $GENERATOR" >&2
    exit 1
  fi
}

install_packages() {
  if [[ "$SKIP_INSTALL" -eq 1 ]]; then
    echo "Skipping package installation."
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "apt-get is not available. Install NGINX manually and rerun the script." >&2
    exit 1
  fi

  echo "Installing NGINX and curl..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN: apt-get update"
    echo "DRY-RUN: apt-get install -y nginx curl"
    return 0
  fi

  run_privileged apt-get update
  run_privileged apt-get install -y nginx curl
}

resolve_cert_paths() {
  local source_dir="${SCRIPT_DIR}/certs"
  if [[ -n "$TLS_CERT_DIR" ]]; then
    if [[ "$TLS_CERT_DIR" = ~* ]]; then
      source_dir="${TLS_CERT_DIR/#\~/$HOME}"
    elif [[ "$TLS_CERT_DIR" = /* ]]; then
      source_dir="$TLS_CERT_DIR"
    else
      source_dir="${SCRIPT_DIR}/${TLS_CERT_DIR}"
    fi
  fi

  if [[ -n "$SSL_CERT_PATH" && -n "$SSL_KEY_PATH" ]]; then
    return 0
  fi

  local cert_file=""
  local key_file=""

  if [[ -n "$TLS_CERT_FILE" ]]; then
    cert_file="$source_dir/$TLS_CERT_FILE"
  fi
  if [[ -n "$TLS_KEY_FILE" ]]; then
    key_file="$source_dir/$TLS_KEY_FILE"
  fi

  if [[ -z "$cert_file" ]]; then
    for candidate in "$source_dir/server.crt" "$source_dir/cert.pem" "$source_dir/fullchain.pem"; do
      if [[ -f "$candidate" ]]; then cert_file="$candidate"; break; fi
    done
  fi

  if [[ -z "$key_file" ]]; then
    for candidate in "$source_dir/key.pem" "$source_dir/privkey.pem" "$source_dir/server.key"; do
      if [[ -f "$candidate" ]]; then key_file="$candidate"; break; fi
    done
  fi

  if [[ -n "$cert_file" && -n "$key_file" ]]; then
    local target_cert="$CERT_TARGET_DIR/server.crt"
    local target_key="$CERT_TARGET_DIR/server.key"

    # 원본을 기억해 둔다. dry-run 일 때는 복사본이 아직 없으므로 이쪽을 검사한다.
    SRC_CERT_PATH="$cert_file"
    SRC_KEY_PATH="$key_file"

    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "DRY-RUN: mkdir -p ${CERT_TARGET_DIR}"
      [[ "$cert_file" != "$target_cert" ]] && echo "DRY-RUN: cp ${cert_file} ${target_cert}"
      [[ "$key_file" != "$target_key" ]] && echo "DRY-RUN: cp ${key_file} ${target_key}"
    else
      run_privileged mkdir -p "$CERT_TARGET_DIR"
      if [[ "$cert_file" != "$target_cert" ]]; then
        run_privileged cp "$cert_file" "$target_cert"
      fi
      if [[ "$key_file" != "$target_key" ]]; then
        run_privileged cp "$key_file" "$target_key"
      fi
    fi

    SSL_CERT_PATH="$target_cert"
    SSL_KEY_PATH="$target_key"
    return 0
  fi

  return 1
}

validate_certificates() {
  # dry-run 에서는 /etc/nginx/certs 로 복사하지 않았으므로 원본을 검사한다.
  local cert="$SSL_CERT_PATH"
  local key="$SSL_KEY_PATH"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    cert="$SRC_CERT_PATH"
    key="$SRC_KEY_PATH"
  fi

  if [[ -z "$cert" || -z "$key" ]]; then
    echo "Certificate paths were not resolved." >&2
    return 1
  fi

  if [[ ! -f "$cert" ]]; then
    echo "Certificate file not found: $cert" >&2
    return 1
  fi

  if [[ ! -f "$key" ]]; then
    echo "Private key file not found: $key" >&2
    return 1
  fi

  if command -v openssl >/dev/null 2>&1; then
    if ! openssl x509 -in "$cert" -noout >/dev/null 2>&1; then
      echo "Certificate file is invalid: $cert" >&2
      return 1
    fi
    if ! openssl pkey -in "$key" -noout >/dev/null 2>&1; then
      echo "Private key file is invalid: $key" >&2
      return 1
    fi
  else
    echo "openssl is not installed; skipping certificate validation." >&2
  fi

  echo "Certificate validation passed for $cert and $key"
  return 0
}

# 서비스 선언을 파싱하고 location 충돌만 확인한다. 인증서가 없어도 돌아간다.
check_declarations() {
  require_python
  python3 "$GENERATOR" \
    --services-dir "$SERVICES_DIR" \
    --template "$CONFIG_TEMPLATE_PATH" \
    --check
}

write_nginx_config() {
  require_python

  if ! resolve_cert_paths; then
    echo "No certificate files were found; HTTPS will not be configured correctly." >&2
    return 1
  fi

  if ! validate_certificates; then
    echo "Certificate validation failed; config will not be written." >&2
    return 1
  fi

  # 먼저 임시 파일로 만든 뒤 옮긴다. 생성이 실패하면 기존 설정을 건드리지 않는다.
  STAGED_CONFIG="$(mktemp)"

  python3 "$GENERATOR" \
    --services-dir "$SERVICES_DIR" \
    --template "$CONFIG_TEMPLATE_PATH" \
    --listen-port "$LISTEN_PORT" \
    --ssl-port "$SSL_PORT" \
    --max-body "$MAX_BODY" \
    --cert-path "$SSL_CERT_PATH" \
    --key-path "$SSL_KEY_PATH" \
    --output "$STAGED_CONFIG"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN: would write ${CONFIG_DEST}:"
    echo "----------------------------------------"
    cat "$STAGED_CONFIG"
    echo "----------------------------------------"
    return 0
  fi

  echo "Writing NGINX config to ${CONFIG_DEST}"
  run_privileged mkdir -p /etc/nginx/conf.d
  run_privileged cp "$STAGED_CONFIG" "$CONFIG_DEST"
}

reload_nginx() {
  if [[ "$SKIP_RELOAD" -eq 1 ]]; then
    echo "Skipping NGINX reload."
    return 0
  fi

  echo "Validating NGINX configuration"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN: nginx -t"
    echo "DRY-RUN: nginx -s reload"
    return 0
  fi

  run_privileged nginx -t

  if command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --all 2>/dev/null | grep -q 'nginx.service'; then
    run_privileged systemctl reload nginx
  else
    run_privileged nginx -s reload || run_privileged nginx
  fi

  echo "NGINX reloaded"
}

main() {
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    check_declarations
    return 0
  fi

  install_packages
  write_nginx_config
  reload_nginx
  echo "Installation complete"
}

main "$@"
