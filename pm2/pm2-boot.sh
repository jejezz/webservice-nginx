#!/usr/bin/env bash
# 부팅 시 진입점. crontab 의 @reboot 줄이 이 스크립트를 부른다.
#
#   @reboot sleep 20 && /bin/bash <루트>/pm2/pm2-boot.sh >> <루트>/pm2/pm2-boot.log 2>&1
#
# cron 은 최소 환경(PATH=/usr/bin:/bin)으로 돌아서, 대화형 셸에서 되던 pm2 가
# 여기서는 안 잡힌다. 이 서버의 pm2 는 /usr/local/bin 에 있다.
set -euo pipefail

export PATH="/usr/local/bin:/usr/local/sbin:$PATH"

# nvm 으로 관리하는 서버에서도 동작하도록 있으면 함께 로드한다. (이 서버에는 없음)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
fi

if ! command -v pm2 >/dev/null 2>&1; then
    echo "pm2 not found on PATH: $PATH" >&2
    exit 1
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') pm2 resurrect ($(command -v pm2)) ==="

# 복원되는 목록은 마지막 'pm2 save' 시점의 것이다.
# 선언(pm2-conf)을 고쳤어도 save 를 안 했으면 옛 목록이 돌아온다.
pm2 resurrect
pm2 list
