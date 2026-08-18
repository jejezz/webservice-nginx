#!/usr/bin/env python3
import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import List


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start multiple app instances, write an NGINX upstream config, and reload NGINX."
    )
    parser.add_argument(
        "--app-command",
        required=True,
        help="Command template used to launch each app instance. Use {port} as a placeholder.",
    )
    parser.add_argument(
        "--ports",
        nargs="+",
        default=["5501", "5502", "5503"],
        help="Ports for the app instances. Defaults to 5501 5502 5503.",
    )
    parser.add_argument("--listen-port", type=int, default=8080, help="Port NGINX should listen on.")
    parser.add_argument("--health-path", default="/health", help="Health path to probe after startup.")
    parser.add_argument(
        "--nginx-config",
        default="/etc/nginx/conf.d/face_backend.conf",
        help="Path to the NGINX config file to write.",
    )
    parser.add_argument("--log-dir", default="/tmp/nginx-stack-logs", help="Directory for app logs.")
    parser.add_argument("--state-dir", default="/tmp/nginx-stack-state", help="Directory for PID files.")
    parser.add_argument("--skip-app-start", action="store_true", help="Only write the config and reload NGINX.")
    parser.add_argument("--skip-nginx-reload", action="store_true", help="Do not reload NGINX.")
    parser.add_argument("--dry-run", action="store_true", help="Print commands without executing them.")
    return parser.parse_args()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def render_nginx_conf(ports: List[str], listen_port: int) -> str:
    upstream_servers = "\n".join(
        f"    server 127.0.0.1:{port} max_fails=3 fail_timeout=10s;" for port in ports
    )
    return f"""upstream face_backend {{
    least_conn;
{upstream_servers}

    keepalive 32;
}}

server {{
    listen {listen_port};
    server_name _;

    location / {{
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 5s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;

        proxy_pass http://face_backend;
    }}
}}
"""


def write_nginx_config(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"Wrote NGINX config to {path}")


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def start_app(command_template: str, port: str, log_dir: Path, state_dir: Path, dry_run: bool) -> int | None:
    pid_file = state_dir / f"{port}.pid"
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
            if process_exists(pid):
                print(f"Port {port} already running with PID {pid}; skipping")
                return pid
        except ValueError:
            pass

    log_path = log_dir / f"app-{port}.log"
    ensure_dir(log_dir)
    ensure_dir(state_dir)

    command = command_template.replace("{port}", port)
    print(f"Starting app on port {port}: {command}")

    if dry_run:
        return None

    env = os.environ.copy()
    env.update({"PORT": port, "APP_PORT": port, "HOST": "127.0.0.1"})

    with log_path.open("a", encoding="utf-8") as log_handle:
        process = subprocess.Popen(
            command,
            shell=True,
            cwd=os.getcwd(),
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    pid_file.write_text(str(process.pid), encoding="utf-8")
    print(f"Started app on port {port} with PID {process.pid}; log: {log_path}")
    return process.pid


def probe_health(port: str, health_path: str, timeout: int = 10) -> bool:
    import urllib.request

    url = f"http://127.0.0.1:{port}{health_path}"
    for _ in range(timeout):
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.getcode() < 500:
                    print(f"Probe succeeded for {url}")
                    return True
        except Exception:
            pass
        time.sleep(1)
    print(f"Probe did not succeed for {url}")
    return False


def reload_nginx() -> None:
    if shutil.which("nginx") is None:
        raise RuntimeError("nginx is not installed or not on PATH")

    print("Validating NGINX configuration")
    subprocess.run(["nginx", "-t"], check=True)

    if shutil.which("systemctl") is not None:
        result = subprocess.run(["systemctl", "reload", "nginx"], check=False)
        if result.returncode != 0:
            print("systemctl reload failed; trying nginx -s reload")
            subprocess.run(["nginx", "-s", "reload"], check=True)
    else:
        subprocess.run(["nginx", "-s", "reload"], check=True)

    print("NGINX reloaded")


def main() -> int:
    args = parse_args()

    if not args.app_command:
        print("An app command is required")
        return 2

    config_path = Path(args.nginx_config)
    log_dir = Path(args.log_dir)
    state_dir = Path(args.state_dir)
    ensure_dir(log_dir)
    ensure_dir(state_dir)

    nginx_conf = render_nginx_conf(args.ports, args.listen_port)
    write_nginx_config(config_path, nginx_conf)

    if not args.skip_app_start:
        for port in args.ports:
            start_app(args.app_command, port, log_dir, state_dir, args.dry_run)
            if not args.dry_run:
                probe_health(port, args.health_path)

    if not args.skip_nginx_reload and not args.dry_run:
        reload_nginx()

    print("Done")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted")
        raise SystemExit(130)
    except subprocess.CalledProcessError as exc:
        print(f"Command failed with exit code {exc.returncode}")
        raise SystemExit(exc.returncode)
    except RuntimeError as exc:
        print(str(exc))
        raise SystemExit(1)
