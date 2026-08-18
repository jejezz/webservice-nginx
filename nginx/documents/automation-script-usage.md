> **지난 구조의 문서입니다.** 여기 나오는 `run_nginx_stack.py` 는 앱 인스턴스를
> 직접 띄웁니다 — 지금은 프로세스 기동이 pm2 담당이라 실행하면 충돌합니다.
> 현재 절차는 [../README.md](../README.md) 를 보세요.
> (경로는 `WebServices/` 루트 기준입니다.)

# Automation script usage

Use the helper script to start three app instances, write the NGINX upstream config, and reload NGINX in one step.

## Example

```bash
python3 nginx/run_nginx_stack.py \
  --app-command 'python3 app.py --port {port}' \
  --ports 5501 5502 5503 \
  --listen-port 8080
```

## What it does

- writes an NGINX config to `/etc/nginx/conf.d/face_backend.conf`
- starts one app process per port
- probes each app on the health path
- reloads NGINX so traffic flows through the new upstream

## Useful flags

- `--dry-run`: print the commands without starting anything
- `--skip-app-start`: only write the config and reload NGINX
- `--skip-nginx-reload`: skip the NGINX reload step
- `--health-path /health`: change the path used for probing

## Notes

- The command template must include `{port}`.
- The script uses `PORT`, `APP_PORT`, and `HOST` environment variables when launching the app.
- Logs are written to `/tmp/nginx-stack-logs` and PID files to `/tmp/nginx-stack-state`.
