#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 {install|update}"
    exit 1
}

install_nginx() {
    echo "=== Installing Nginx ==="

    if command -v nginx &>/dev/null; then
        echo "Nginx is already installed: $(nginx -v 2>&1)"
        echo "Use '$0 update' to update instead."
        exit 1
    fi

    sudo apt-get update
    sudo apt-get install -y nginx

    # 포트 충돌 방지: 설치 후 자동 시작하지 않음
    # setup_nginx.sh로 설정 완료 후 시작할 것
    sudo systemctl stop nginx 2>/dev/null || true
    sudo systemctl enable nginx

    echo "=== Nginx installed successfully ==="
    echo "Run ./setup_nginx.sh to configure and start Nginx."
    nginx -v 2>&1
}

update_nginx() {
    echo "=== Updating Nginx ==="

    if ! command -v nginx &>/dev/null; then
        echo "Nginx is not installed. Use '$0 install' first."
        exit 1
    fi

    echo "Current version: $(nginx -v 2>&1)"

    sudo apt-get update
    sudo apt-get install -y --only-upgrade nginx

    echo "Updated version: $(nginx -v 2>&1)"
    sudo systemctl restart nginx

    echo "=== Nginx updated successfully ==="
}

if [[ $# -ne 1 ]]; then
    usage
fi

case "$1" in
    install) install_nginx ;;
    update)  update_nginx ;;
    *)       usage ;;
esac
