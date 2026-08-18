#!/usr/bin/env python3
"""services/*/nginx-conf/*.ini 를 읽어 nginx 설정을 만든다.

각 서비스가 자기에게 필요한 포트와 라우트를 선언하고, 이 스크립트가 합친다.
라우트를 바꾸려면 템플릿이 아니라 해당 서비스의 nginx-conf/ 를 고친다.

스키마: WebServices/docs/nginx-conf.md

사용법:
    generate_nginx_conf.py --services-dir ../services --template nginx/server.conf.template
    generate_nginx_conf.py ... --output /etc/nginx/conf.d/path-routing.conf
    generate_nginx_conf.py ... --check          # 파싱과 충돌 검사만
"""

import argparse
import configparser
import glob
import os
import re
import sys

# 설정 파일과 주석에 한글·em dash 가 들어가므로 출력 스트림을 UTF-8 로 고정한다.
# (기본 인코딩이 UTF-8 이 아닌 환경에서 표준 출력으로 뽑을 때 깨지는 것을 막는다)
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PROTOCOL = "http"
DEFAULT_HEALTH_PATH = "/health"
DEFAULT_TIMEOUT = 120
DEFAULT_ORDER = 100


class ConfigError(Exception):
    """설정이 잘못됐을 때. 조용히 넘어가지 않고 여기서 멈춘다."""


def die(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def as_bool(value, default=False):
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def parse_ports(value):
    ports = []
    for token in str(value or "").split():
        try:
            port = int(token)
        except ValueError:
            raise ConfigError(f"포트가 숫자가 아닙니다: {token!r}")
        if not (1 <= port <= 65535):
            raise ConfigError(f"포트 범위를 벗어났습니다: {port}")
        ports.append(port)
    return ports


def upstream_name(service_name):
    """nginx 식별자로 쓸 수 있게 다듬는다. face-recognition-server -> face_recognition_server_backend"""
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", service_name).strip("_").lower()
    return f"{slug}_backend"


class Route:
    def __init__(self, service, section_name, cfg):
        self.service = service
        self.key = section_name.split(":", 1)[1] if ":" in section_name else section_name

        location = (cfg.get("location") or "").strip()
        if not location:
            raise ConfigError(f"[{section_name}] 에 location 이 없습니다")
        self.location = location

        self.proxy_path = (cfg.get("proxy_path") or "").strip()
        self.websocket = as_bool(cfg.get("websocket"))
        self.buffering = (cfg.get("buffering") or "on").strip().lower() != "off"
        self.max_body = (cfg.get("max_body") or "").strip()

        try:
            self.timeout = int(cfg.get("timeout") or DEFAULT_TIMEOUT)
            self.order = int(cfg.get("order") or DEFAULT_ORDER)
        except ValueError as err:
            raise ConfigError(f"[{section_name}] timeout/order 는 숫자여야 합니다: {err}")

    @property
    def match_key(self):
        """충돌 검사용 정규화 키. 'location  =  /a/' 와 'location = /a/' 를 같게 본다."""
        return re.sub(r"\s+", " ", self.location).strip()

    def render(self):
        proto = "https" if self.service.protocol == "https" else "http"
        target = f"{proto}://{self.service.upstream}{self.proxy_path}"

        lines = [f"    location {self.location} {{"]
        lines.append(f"        # {self.service.name} ({self.key})")
        lines.append("        proxy_http_version 1.1;")

        if self.websocket:
            lines.append("        proxy_set_header Upgrade $http_upgrade;")
            lines.append("        proxy_set_header Connection $connection_upgrade;")
        else:
            lines.append('        proxy_set_header Connection "";')

        lines.append("        proxy_set_header Host $host;")
        lines.append("        proxy_set_header X-Real-IP $remote_addr;")
        lines.append("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;")
        lines.append("        proxy_set_header X-Forwarded-Proto https;")
        lines.append("")

        if self.max_body:
            lines.append(f"        client_max_body_size {self.max_body};")

        lines.append("        proxy_connect_timeout 5s;")
        lines.append(f"        proxy_send_timeout {self.timeout}s;")
        lines.append(f"        proxy_read_timeout {self.timeout}s;")

        if not self.buffering:
            lines.append("")
            lines.append("        # SSE — 버퍼링을 끄지 않으면 이벤트가 모였다가 한꺼번에 나간다.")
            lines.append("        proxy_buffering off;")
            lines.append("        proxy_cache off;")
            lines.append("        chunked_transfer_encoding on;")

        if self.service.protocol == "https":
            lines.append("")
            lines.append("        # 백엔드가 자체 서명 인증서를 쓰는 경우가 많아 검증하지 않는다.")
            lines.append("        proxy_ssl_verify off;")

        lines.append("")
        lines.append(f"        proxy_pass {target};")
        lines.append("    }")
        return "\n".join(lines)


class Service:
    def __init__(self, path, directory_name, parser):
        self.path = path

        if not parser.has_section("service"):
            raise ConfigError("[service] 섹션이 없습니다")

        section = parser["service"]
        self.name = (section.get("name") or directory_name).strip()
        self.host = (section.get("host") or DEFAULT_HOST).strip()
        self.protocol = (section.get("protocol") or DEFAULT_PROTOCOL).strip().lower()
        self.health_path = (section.get("health_path") or DEFAULT_HEALTH_PATH).strip()
        self.dashboard_path = (section.get("dashboard_path") or "").strip()
        self.enabled = as_bool(section.get("enabled"), default=True)

        if self.protocol not in ("http", "https"):
            raise ConfigError(f"protocol 은 http 또는 https 여야 합니다: {self.protocol!r}")

        self.ports = parse_ports(section.get("ports"))
        if not self.ports:
            raise ConfigError("[service] 에 ports 가 없습니다")

        self.upstream = upstream_name(self.name)

        self.routes = []
        for section_name in parser.sections():
            if section_name == "service":
                continue
            if not section_name.startswith("route:") and section_name != "route":
                raise ConfigError(f"알 수 없는 섹션입니다: [{section_name}]")
            self.routes.append(Route(self, section_name, parser[section_name]))

    def render_upstream(self):
        lines = [f"upstream {self.upstream} {{"]
        if len(self.ports) > 1:
            lines.append("    least_conn;")
        for port in self.ports:
            lines.append(f"    server {self.host}:{port} max_fails=3 fail_timeout=10s;")
        lines.append("}")
        return "\n".join(lines)


def load_services(services_dir):
    services = []
    pattern = os.path.join(services_dir, "*", "nginx-conf", "*.ini")

    for ini_path in sorted(glob.glob(pattern)):
        directory_name = os.path.basename(os.path.dirname(os.path.dirname(ini_path)))

        parser = configparser.ConfigParser()
        # 키 대소문자를 보존할 필요는 없지만, 값의 대소문자는 그대로 둔다.
        parser.optionxform = str.lower
        try:
            with open(ini_path, encoding="utf-8") as handle:
                parser.read_file(handle)
        except configparser.Error as err:
            die(f"{ini_path}: INI 파싱 실패\n  {err}")

        try:
            service = Service(ini_path, directory_name, parser)
        except ConfigError as err:
            die(f"{ini_path}: {err}")

        if not service.enabled:
            print(f"  skip    {service.name} (enabled = false)", file=sys.stderr)
            continue

        services.append(service)

    return services


def check_conflicts(services):
    """서로 다른 서비스가 같은 location 을 선언하면 멈춘다.

    조용히 덮어쓰면 한쪽 서비스가 이유 없이 죽는다.
    설정을 만드는 시점에 터지는 편이 낫다.
    """
    seen = {}
    duplicates = []

    for service in services:
        for route in service.routes:
            key = route.match_key
            if key in seen:
                duplicates.append((key, seen[key], route.service.path))
            else:
                seen[key] = route.service.path

    if duplicates:
        lines = []
        for key, first, second in duplicates:
            lines.append(f"duplicate location {key!r}")
            lines.append(f"  {first}")
            lines.append(f"  {second}")
        die("\n".join(lines))

    names = {}
    for service in services:
        if service.name in names:
            die(f"duplicate service name {service.name!r}\n  {names[service.name]}\n  {service.path}")
        names[service.name] = service.path

    upstreams = {}
    for service in services:
        if service.upstream in upstreams:
            die(
                f"upstream 이름이 겹칩니다: {service.upstream!r}\n"
                f"  {upstreams[service.upstream]}\n  {service.path}\n"
                "  서비스 이름을 다르게 지으세요."
            )
        upstreams[service.upstream] = service.path


def render(services, template_text, listen_port, ssl_port, cert_path, key_path, max_body):
    upstreams = "\n\n".join(s.render_upstream() for s in services)

    # 정규식 location 은 적힌 순서대로 검사되므로 order 가 결과를 바꾼다.
    # 같은 order 안에서는 서비스 이름 -> 라우트 키 순으로 안정 정렬한다.
    routes = [r for s in services for r in s.routes]
    routes.sort(key=lambda r: (r.order, r.service.name, r.key))

    locations = "\n\n".join(r.render() for r in routes)

    output = template_text
    output = output.replace("__UPSTREAMS__", upstreams)
    output = output.replace("__LOCATIONS__", locations)
    output = output.replace("__LISTEN_PORT__", str(listen_port))
    output = output.replace("__SSL_PORT__", str(ssl_port))
    output = output.replace("__SSL_CERT_PATH__", cert_path)
    output = output.replace("__SSL_KEY_PATH__", key_path)
    output = output.replace("__MAX_BODY__", max_body)

    leftover = re.findall(r"__[A-Z_]+__", output)
    if leftover:
        die(f"템플릿에 치환되지 않은 자리표시자가 남았습니다: {', '.join(sorted(set(leftover)))}")

    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--services-dir", required=True, help="services/ 디렉토리 경로")
    parser.add_argument("--template", required=True, help="서버 골격 템플릿 경로")
    parser.add_argument("--output", help="쓸 파일 경로. 없으면 표준 출력")
    parser.add_argument("--listen-port", default="80")
    parser.add_argument("--ssl-port", default="443")
    parser.add_argument("--cert-path", default="")
    parser.add_argument("--key-path", default="")
    parser.add_argument("--max-body", default="100m")
    parser.add_argument("--check", action="store_true", help="파싱과 충돌 검사만 하고 끝낸다")
    args = parser.parse_args()

    services_dir = os.path.abspath(args.services_dir)
    if not os.path.isdir(services_dir):
        die(f"서비스 디렉토리가 없습니다: {services_dir}")

    print(f"Scanning {services_dir}/*/nginx-conf/*.ini", file=sys.stderr)
    services = load_services(services_dir)

    if not services:
        die(f"nginx-conf/*.ini 를 하나도 찾지 못했습니다: {services_dir}")

    check_conflicts(services)

    for service in services:
        ports = " ".join(str(p) for p in service.ports)
        routes = ", ".join(r.match_key for r in service.routes) or "(라우트 없음)"
        print(f"  ok      {service.name:24} {ports:16} {routes}", file=sys.stderr)

    if args.check:
        print(f"{len(services)} services, no conflicts.", file=sys.stderr)
        return

    if not args.cert_path or not args.key_path:
        die("--cert-path 와 --key-path 가 필요합니다")

    try:
        with open(args.template, encoding="utf-8") as handle:
            template_text = handle.read()
    except OSError as err:
        die(f"템플릿을 읽을 수 없습니다: {err}")

    output = render(
        services,
        template_text,
        args.listen_port,
        args.ssl_port,
        args.cert_path,
        args.key_path,
        args.max_body,
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(output)
        print(f"Wrote {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(output)


if __name__ == "__main__":
    main()
