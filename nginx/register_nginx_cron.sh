#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SCRIPT="${SCRIPT_DIR}/install_nginx_stack.sh"
LOG_FILE="${SCRIPT_DIR}/nginx-cron.log"
# --skip-app-start 는 제거됐다. 앱 프로세스는 pm2 가 띄우고 이 스크립트는
# conf.d 재생성 + nginx reload 만 한다. 알 수 없는 인자를 주면 exit 2 로 죽는다.
JOB="@reboot sleep 20 && /bin/bash ${START_SCRIPT} --skip-install >> ${LOG_FILE} 2>&1"

if [[ ! -f "$START_SCRIPT" ]]; then
  echo "Startup script not found: $START_SCRIPT" >&2
  exit 1
fi

if [[ ! -x "$START_SCRIPT" ]]; then
  chmod +x "$START_SCRIPT"
fi

TMP_CRON="$(mktemp)"
trap 'rm -f "$TMP_CRON"' EXIT

if crontab -l 2>/dev/null > "$TMP_CRON"; then
  :
else
  : > "$TMP_CRON"
fi

# Remove any previous entries created by this script or the nginx startup flow
python3 - "$TMP_CRON" "$JOB" "$START_SCRIPT" "$LOG_FILE" <<'PY'
import sys
path, job, start_script, log_file = sys.argv[1:5]
with open(path, 'r', encoding='utf-8') as f:
    lines = [line.rstrip('\n') for line in f if line.strip()]
kept = []
for line in lines:
    if line.startswith('# Added by register_nginx_cron.sh'):
        continue
    if start_script in line or log_file in line or 'install_nginx_stack.sh' in line or 'register_nginx_cron.sh' in line:
        continue
    if line == job:
        continue
    kept.append(line)
with open(path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(kept) + ('\n' if kept else ''))
PY

{
  echo "# Added by register_nginx_cron.sh"
  echo "$JOB"
} >> "$TMP_CRON"

crontab "$TMP_CRON"

echo "Cron entry installed."
echo "Job: $JOB"
echo "Current crontab:"
crontab -l
