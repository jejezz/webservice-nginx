#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 {install|update|uninstall}"
    exit 1
}

check_node() {
    if ! command -v node &>/dev/null; then
        echo "Error: Node.js is not installed."
        echo "Install Node.js first: https://nodejs.org/"
        exit 1
    fi
    echo "Node.js: $(node -v)"
}

install_pm2() {
    echo "=== Installing PM2 ==="
    check_node

    if command -v pm2 &>/dev/null; then
        echo "PM2 is already installed: $(pm2 -v)"
        echo "Use '$0 update' to update instead."
        exit 1
    fi

    sudo npm install -g pm2

    # systemd 서비스 등록 (재부팅 시 자동 시작)
    pm2 startup systemd -u "$USER" --hp "$HOME" | grep 'sudo' | bash || true

    echo ""
    echo "=== PM2 installed successfully ==="
    echo "PM2: $(pm2 -v)"
    echo ""
    echo "Next steps:"
    echo "  cd $(dirname "$0")"
    echo "  pm2 start ecosystem.config.js"
    echo "  pm2 save"
}

update_pm2() {
    echo "=== Updating PM2 ==="
    check_node

    if ! command -v pm2 &>/dev/null; then
        echo "PM2 is not installed. Use '$0 install' first."
        exit 1
    fi

    echo "Current: $(pm2 -v)"
    sudo npm install -g pm2@latest
    echo "Updated: $(pm2 -v)"

    pm2 update

    echo "=== PM2 updated successfully ==="
}

uninstall_pm2() {
    echo "=== Uninstalling PM2 ==="

    if ! command -v pm2 &>/dev/null; then
        echo "PM2 is not installed."
        exit 0
    fi

    pm2 kill 2>/dev/null || true
    pm2 unstartup systemd 2>/dev/null || true
    sudo npm uninstall -g pm2

    echo "=== PM2 uninstalled ==="
}

if [[ $# -ne 1 ]]; then
    usage
fi

case "$1" in
    install)   install_pm2 ;;
    update)    update_pm2 ;;
    uninstall) uninstall_pm2 ;;
    *)         usage ;;
esac
