#!/usr/bin/env bash
# Boot-time entry point for cron's @reboot line (see README.md).
#
# cron runs with a minimal environment, so `pm2` isn't on PATH there even
# though it is in an interactive shell (nvm only wires it up via
# ~/.bashrc). Load nvm explicitly instead of relying on PATH.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
fi

if ! command -v pm2 >/dev/null 2>&1; then
    echo "pm2 not found on PATH after sourcing nvm; check NVM_DIR/node version." >&2
    exit 1
fi

pm2 resurrect
