#!/usr/bin/env bash
#
# 이 스크립트는 실행되면 안 됩니다.
#
# pm2-conf/app.ini 의 [app] script 는 enabled 값과 무관하게 필수라서
# (pm2/ecosystem.config.js 105행) 자리를 채우기 위해 존재합니다.
# app.ini 는 enabled = false 이므로 평소에는 pm2 가 이 항목을 아예 모릅니다.
#
# 여기까지 실행이 왔다면 누군가 enabled 를 true 로 바꾼 것입니다.
set -euo pipefail

cat >&2 <<'MSG'
kamailio 는 pm2 가 관리하지 않습니다.

배포판 패키지의 systemd 유닛이 띄웁니다:

    sudo systemctl status kamailio
    sudo systemctl restart kamailio
    journalctl -u kamailio -n 40

services/kamailio/pm2-conf/app.ini 의 enabled 를 false 로 되돌리세요.
자세한 내용은 그 파일의 주석과 services/kamailio/README.md 를 보세요.
MSG

exit 1
