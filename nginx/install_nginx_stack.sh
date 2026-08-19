#!/usr/bin/env bash
# 주 진입점. 서비스 선언을 모아 nginx 설정을 만들고 반영한다.
#
#   ./install_nginx_stack.sh --check          선언 검사만 (sudo 불필요)
#   ./install_nginx_stack.sh --dry-run        만들어질 설정을 출력만
#   sudo ./install_nginx_stack.sh --skip-install   설정 반영 + reload
#
# 라우트는 여기에 없다 — services/*/nginx-conf/*.ini 가 가진다.
# 스키마: ../docs/nginx-conf.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENERATOR="${SCRIPT_DIR}/generate_nginx_conf.py"
OUTPUT_CONF="/etc/nginx/conf.d/path-routing.conf"

# 이관 전 구조가 쓰던 파일. 남아 있으면 default_server 가 중복되거나
# 옛 라우트가 함께 살아 있게 되므로 반영 시점에 걷어낸다.
LEGACY_LINK="/etc/nginx/sites-enabled/reverse-proxy.conf"
DEFAULT_LINK="/etc/nginx/sites-enabled/default"

CHECK_ONLY=0
DRY_RUN=0
SKIP_INSTALL=0
SKIP_RELOAD=0

usage() {
    cat <<'USAGE'
Usage: install_nginx_stack.sh [옵션]

  --check          파싱·충돌 검사만. 아무것도 쓰지 않음 (sudo 불필요)
  --dry-run        만들어질 설정을 표준 출력으로. 아무것도 쓰지 않음
  --skip-install   apt 설치 단계를 건너뜀 (이미 설치된 서버에서 상시 사용)
  --skip-reload    설정만 쓰고 reload 하지 않음
  -h, --help       이 도움말
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check)        CHECK_ONLY=1 ;;
        --dry-run)      DRY_RUN=1 ;;
        --skip-install) SKIP_INSTALL=1 ;;
        --skip-reload)  SKIP_RELOAD=1 ;;
        -h|--help)      usage; exit 0 ;;
        *)              echo "알 수 없는 옵션: $1" >&2; usage; exit 1 ;;
    esac
    shift
done

# root 로 실행되면 그대로, 아니면 필요한 명령에만 sudo 를 붙인다.
# 이렇게 해야 pm2 나 파일 소유권이 root 로 넘어가지 않는다.
run_root() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

if [[ $CHECK_ONLY -eq 1 ]]; then
    exec python3 "$GENERATOR" --check
fi

if [[ $DRY_RUN -eq 1 ]]; then
    echo "=== dry-run: ${OUTPUT_CONF} 에 쓰일 내용 ===" >&2
    python3 "$GENERATOR"
    echo "=== dry-run: 아무것도 쓰지 않았습니다 ===" >&2
    [[ -L "$LEGACY_LINK" ]] && echo "반영 시 제거될 옛 링크: ${LEGACY_LINK}" >&2
    exit 0
fi

if [[ $SKIP_INSTALL -eq 0 ]]; then
    if command -v nginx &>/dev/null; then
        echo "Nginx 는 이미 설치돼 있습니다: $(nginx -v 2>&1)"
    else
        "${SCRIPT_DIR}/install_nginx.sh" install
    fi
fi

# 검사를 먼저 통과해야 아무것도 쓰지 않는다.
python3 "$GENERATOR" --check

TMP_CONF="$(mktemp)"
trap 'rm -f "$TMP_CONF"' EXIT
python3 "$GENERATOR" --output "$TMP_CONF" >/dev/null

echo ""
echo "Writing config to: ${OUTPUT_CONF}"
run_root install -m 0644 -o root -g root "$TMP_CONF" "$OUTPUT_CONF"

if [[ -L "$LEGACY_LINK" || -f "$LEGACY_LINK" ]]; then
    echo "Removing legacy site: ${LEGACY_LINK}"
    run_root rm -f "$LEGACY_LINK"
fi

if [[ -L "$DEFAULT_LINK" || -f "$DEFAULT_LINK" ]]; then
    echo "Removing default site: ${DEFAULT_LINK}"
    run_root rm -f "$DEFAULT_LINK"
fi

echo ""
echo "Testing Nginx configuration..."
if ! run_root nginx -t; then
    echo "Error: nginx -t 실패. reload 하지 않았습니다." >&2
    echo "되돌리려면: sudo rm ${OUTPUT_CONF} && sudo ln -s /etc/nginx/sites-available/reverse-proxy.conf ${LEGACY_LINK} && sudo systemctl reload nginx" >&2
    exit 1
fi

if [[ $SKIP_RELOAD -eq 1 ]]; then
    echo "--skip-reload: reload 하지 않았습니다."
else
    echo "Reloading Nginx..."
    run_root systemctl reload nginx
    echo "=== Setup complete ==="
fi
