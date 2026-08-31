#!/usr/bin/env python3
"""services/*/nginx-conf/*.ini 를 읽어 nginx 설정을 만든다.

각 서비스가 자기에게 필요한 포트와 라우트를 선언하고, 이 스크립트가 합친다.
라우트를 바꾸려면 템플릿이 아니라 해당 서비스의 nginx-conf/ 를 고친다.
서버 수준 값(listen 포트, TLS, mTLS, 포트 포워딩, default_route)은
nginx-stack.conf 가 가진다.

스키마: docs/nginx-conf.md

사용법:
    generate_nginx_conf.py --check              # 파싱과 충돌 검사만 (sudo 불필요)
    generate_nginx_conf.py                      # 생성 결과를 표준 출력으로
    generate_nginx_conf.py --output /etc/nginx/conf.d/path-routing.conf
"""

import argparse
import configparser
import json
import difflib
import glob
import os


# ── 사이트 값 ───────────────────────────────────────────────────────
#
# 여러 서비스가 함께 쓰는 값은 저장소 뿌리의 site/settings.ini 에 있다
# (site/README.md). server_name 이 그중 하나다 — 인증서(Let's Encrypt)와
# 앱에게 알려 줄 주소가 같은 이름이어야 하는데, 각자 적게 두면 어긋나고 그
# 어긋남은 조용하다.
#
# **nginx-stack.conf 가 이긴다.** 거기 적으면 그 값을 쓰고, 비어 있을 때만
# 사이트 값을 본다. 둘 다 없으면 예전처럼 localhost 다.
def site_get(key, fallback=""):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "settings.ini")
    try:
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line[0] in "#;":
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    if k.strip() == key:
                        return v.strip()
    except OSError:
        pass
    return fallback


LETSENCRYPT_DIR = "/etc/letsencrypt"


def resolve_tls_mode(host):
    """site/settings.ini 의 tls_mode 를 실제 경로로 쓸 값 하나로 굳힌다.

    돌려주는 것은 ('public' | 'private', 왜 그렇게 갈렸는지).

    ── auto 를 무엇으로 판정하나 ────────────────────────────────────
    **`live/` 를 보지 않는다.** 거기는 0700 root 라 sudo 없이는 못 읽고, 이
    생성기는 `--check` 로 sudo 없이 도는 경로가 있다. 파일 유무로 갈랐다면
    같은 장비가 sudo 로 돌릴 때와 아닐 때 **다른 판정**을 내게 된다.

    그 옆의 `renewal/<이름>.conf` 는 0755 라 누구나 읽는다. 그리고 그 파일이
    있다는 것은 곧 **certbot 이 이 이름으로 발급해 갱신까지 걸어 두었다** 는
    뜻이다 — 우리가 알고 싶은 것이 정확히 그것이다.
    """
    mode = (site_get("tls_mode") or "auto").strip().lower()

    if mode == "public":
        return "public", "site/settings.ini 의 tls_mode = public"
    if mode == "private":
        return "private", "site/settings.ini 의 tls_mode = private"

    if mode != "auto":
        # 모르는 값으로 조용히 public 에 가지 않는다. 안전한 쪽으로 떨어뜨리고
        # 그 사실을 이유에 적는다.
        return "private", f"tls_mode 값을 알 수 없어 private 로 둡니다: {mode!r}"

    if not host or host == "localhost":
        return "private", "auto — 공개 호스트 이름이 없습니다 (site/settings.ini 의 host)"

    renewal = os.path.join(LETSENCRYPT_DIR, "renewal", f"{host}.conf")
    if os.path.isfile(renewal):
        return "public", f"auto — certbot 이 {host} 로 발급해 두었습니다 ({renewal})"

    return "private", f"auto — {host} 로 발급받은 공인 인증서가 없습니다 ({renewal} 없음)"


import re
import sys

# 설정 파일과 주석에 한글이 들어가므로 출력 스트림을 UTF-8 로 고정한다.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PROTOCOL = "http"
DEFAULT_HEALTH_PATH = "/health"
DEFAULT_TIMEOUT = 120
DEFAULT_ORDER = 100

# install_nginx_stack.sh 가 설치하는 곳. 설치본이 지금 선언과 같은지 보는 데 쓴다.
INSTALLED_CONF = "/etc/nginx/conf.d/path-routing.conf"


class ConfigError(Exception):
    """설정이 잘못됐을 때. 조용히 넘어가지 않고 여기서 멈춘다."""


# ── 점검 규약 (docs/check-contract.md) ────────────────────────────────
#
# 셸 쪽은 lib/check-report.sh 를 쓰지만 이 파일은 파이썬이라 같은 형식을 직접
# 낸다. 사람용 출력은 전부 stderr 로 가므로 JSON 은 stdout 으로 깨끗이 나간다.
CHECK_JSON = False
CHECK_ENTRIES = []


def judge(level, text):
    CHECK_ENTRIES.append({"level": level, "text": text})


def check_state():
    levels = {e["level"] for e in CHECK_ENTRIES}
    if "problem" in levels:
        return "problem"
    if "pending" in levels:
        return "incomplete"
    return "complete"


def check_finish():
    """JSON 모드면 결과를 찍고 그 자리에서 끝낸다."""
    if not CHECK_JSON:
        return
    state = check_state()
    json.dump({"step": "nginx.routes", "state": state, "checks": CHECK_ENTRIES},
              sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    sys.exit(0 if state == "complete" else 1)


def die(message):
    # JSON 모드에서는 멈추는 대신 문제로 기록하고 정상적으로 끝낸다 —
    # 마법사가 그 이유를 화면에 보여 줄 수 있어야 한다.
    if CHECK_JSON:
        judge("problem", message.replace("\n", " ").strip())
        check_finish()
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def reader(path):
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str.lower
    try:
        with open(path, encoding="utf-8") as handle:
            parser.read_file(handle)
    except OSError as err:
        die(f"읽을 수 없습니다: {err}")
    except configparser.Error as err:
        die(f"{path}: INI 파싱 실패\n  {err}")
    return parser


def as_bool(value, default=False):
    if value is None or str(value).strip() == "":
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
    """nginx 식별자로 쓸 수 있게 다듬는다. ws-bridge -> ws_bridge_backend"""
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

        # 같은 데몬의 **다른 포트**로 보내는 라우트. 헬스는 [service] 의 첫 포트로
        # 그대로 가므로, 포트마다 서비스를 쪼개지 않아도 된다.
        #
        # 왜 [service] 의 ports 에 더하면 안 되는가: 거기 둘 이상을 적으면
        # least_conn 로드밸런싱이 된다. 그건 "같은 것을 여러 벌 돌린다" 는 뜻이고,
        # 여기서 필요한 것은 "같은 데몬의 다른 입구" 다.
        port_value = (cfg.get("port") or "").strip()
        if port_value:
            try:
                self.port = int(port_value)
            except ValueError:
                raise ConfigError(f"[{section_name}] port 는 숫자여야 합니다: {port_value!r}")
            if not (1 <= self.port <= 65535):
                raise ConfigError(f"[{section_name}] port 가 범위를 벗어납니다: {self.port}")
        else:
            self.port = None
        self.buffering = (cfg.get("buffering") or "on").strip().lower() != "off"
        self.max_body = (cfg.get("max_body") or "").strip()

        try:
            self.timeout = int(cfg.get("timeout") or DEFAULT_TIMEOUT)
            self.order = int(cfg.get("order") or DEFAULT_ORDER)
        except ValueError as err:
            raise ConfigError(f"[{section_name}] timeout/order 는 숫자여야 합니다: {err}")

    @property
    def upstream(self):
        """이 라우트가 보낼 곳. port 를 적었으면 그 포트 전용 업스트림이다."""
        if self.port is None:
            return self.service.upstream
        return f"{self.service.upstream[:-len('_backend')]}_{self.key}_backend"

    @property
    def match_key(self):
        """충돌 검사용 정규화 키. 'location  =  /a/' 와 'location = /a/' 를 같게 본다."""
        return re.sub(r"\s+", " ", self.location).strip()

    def render(self):
        proto = "https" if self.service.protocol == "https" else "http"
        target = f"{proto}://{self.upstream}{self.proxy_path}"

        lines = [f"    location {self.location} {{"]
        lines.append(f"        # {self.service.name} ({self.key})")
        lines.append(f"        proxy_pass {target};")
        lines.append("        proxy_http_version 1.1;")
        lines.append("        proxy_set_header Host $host;")
        lines.append("        proxy_set_header X-Real-IP $remote_addr;")
        lines.append("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;")
        lines.append("        proxy_set_header X-Forwarded-Proto $scheme;")

        # 클라이언트 인증서 검증 결과. nginx 가 TLS 를 끊으므로 백엔드는 이것을
        # 직접 볼 수 없다.
        #
        # **mTLS 를 쓰지 않아도 반드시 넣는다.** proxy_set_header 는 클라이언트가
        # 같은 이름으로 보낸 헤더를 덮어쓴다. 빼 두면 아무나
        # `X-SSL-Client-Verify: SUCCESS` 를 붙여 보내 검사를 통째로 우회한다.
        # 지금은 읽는 곳이 없지만, 나중에 읽기 시작할 때 이 줄이 없으면
        # 그 순간부터 구멍이 된다.
        #
        # 값은 mTLS 가 꺼져 있으면 빈 문자열이고, 그때 nginx 는 헤더를 아예
        # 보내지 않는다(클라이언트가 보낸 것도 함께 사라진다). TLS 위에서
        # verify_client 가 켜져 있으면 NONE / SUCCESS / FAILED 가 온다.
        lines.append("        proxy_set_header X-SSL-Client-Verify $ssl_client_verify;")
        lines.append("        proxy_set_header X-SSL-Client-DN $ssl_client_s_dn;")

        if self.websocket:
            lines.append("        proxy_set_header Upgrade $http_upgrade;")
            lines.append("        proxy_set_header Connection $connection_upgrade;")

        if self.max_body:
            lines.append(f"        client_max_body_size {self.max_body};")

        lines.append("")
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
        blocks = []

        lines = [f"upstream {self.upstream} {{"]
        if len(self.ports) > 1:
            lines.append("    least_conn;")
        for port in self.ports:
            lines.append(f"    server {self.host}:{port} max_fails=3 fail_timeout=10s;")
        lines.append("}")
        blocks.append("\n".join(lines))

        # port 를 따로 적은 라우트마다 업스트림을 하나씩 더 만든다.
        for route in self.routes:
            if route.port is None:
                continue
            blocks.append(
                f"upstream {route.upstream} {{\n"
                f"    # {self.name} ({route.key}) — 같은 데몬의 다른 입구\n"
                f"    server {self.host}:{route.port} max_fails=3 fail_timeout=10s;\n"
                f"}}"
            )

        return "\n\n".join(blocks)


def load_services(services_dir):
    services = []
    pattern = os.path.join(services_dir, "*", "nginx-conf", "*.ini")

    for ini_path in sorted(glob.glob(pattern)):
        directory_name = os.path.basename(os.path.dirname(os.path.dirname(ini_path)))
        parser = reader(ini_path)

        try:
            service = Service(ini_path, directory_name, parser)
        except ConfigError as err:
            die(f"{ini_path}: {err}")

        if not service.enabled:
            judge("skip", f"{service.name} — 선언이 꺼져 있습니다 (enabled = false)")
            print(f"  skip    {service.name:18} (enabled = false)", file=sys.stderr)
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

    ports = {}
    for service in services:
        for port in service.ports:
            target = f"{service.host}:{port}"
            if target in ports and ports[target] != service.name:
                die(
                    f"서로 다른 서비스가 같은 백엔드를 가리킵니다: {target}\n"
                    f"  {ports[target]}\n  {service.name}"
                )
            ports[target] = service.name


class Stack:
    """nginx-stack.conf — 서버 수준 값."""

    def __init__(self, path):
        parser = reader(path)
        base = os.path.dirname(os.path.abspath(path))
        general = parser["general"] if parser.has_section("general") else {}
        tls = parser["tls"] if parser.has_section("tls") else {}

        def g(key, default=""):
            return (general.get(key) or default).strip()

        def t(key, default=""):
            return (tls.get(key) or default).strip()

        self.server_name = g("server_name") or site_get("host") or "localhost"
        self.listen_port = g("listen_port", "80")
        self.ssl_port = g("ssl_port", "443")
        self.max_body = g("max_body")
        self.default_route = g("default_route")
        self.public_http_port = g("public_http_port")
        self.public_https_port = g("public_https_port")
        self.services_dir = os.path.abspath(os.path.join(base, g("services_dir", "../services")))

        cert_dir = os.path.abspath(os.path.join(base, t("cert_dir", "./cert")))

        # ── 서버 인증서를 어디서 가져오나 ───────────────────────────────
        #
        # 여기 적으면 그것이 이긴다. 비어 있으면 site/settings.ini 의 tls_mode
        # 에서 **파생**한다 — 장비마다 다른 절대경로가 커밋되는 파일에 박히지
        # 않게 하기 위해서다.
        #
        # 어느 쪽으로 갈렸는지는 report_certificate() 가 반드시 남긴다.
        # 조용히 사설로 떨어지는 것이 가장 나쁘다.
        declared_cert = t("cert_file")
        declared_key = t("key_file")
        self.cert_declared = bool(declared_cert or declared_key)

        # 한쪽만 적은 것은 거의 확실히 실수다. 그대로 두면 공인 인증서에 사설
        # 개인키를 짝지어 nginx 가 "key values mismatch" 로 죽는다 — 그 메시지에서
        # 원인을 되짚기 어렵다.
        self.cert_half_declared = bool(declared_cert) != bool(declared_key)

        self.tls_mode = ""          # 선언한 경우 빈 문자열
        self.tls_mode_reason = ""

        if self.cert_declared:
            self.cert = os.path.join(cert_dir, declared_cert or "server/server.crt")
            self.key = os.path.join(cert_dir, declared_key or "server/server.key")
        else:
            self.tls_mode, self.tls_mode_reason = resolve_tls_mode(self.server_name)
            if self.tls_mode == "public":
                live = os.path.join(LETSENCRYPT_DIR, "live", self.server_name)
                self.cert = os.path.join(live, "fullchain.pem")
                self.key = os.path.join(live, "privkey.pem")
            else:
                self.cert = os.path.join(cert_dir, "server/server.crt")
                self.key = os.path.join(cert_dir, "server/server.key")
        client_ca = t("client_ca")
        self.client_ca = os.path.join(cert_dir, client_ca) if client_ca else ""
        self.verify_client = t("verify_client")
        self.acme_webroot = t("acme_webroot")

    @staticmethod
    def _file_state(path):
        """'ok' | 'missing' | 'unknown'

        os.path.isfile() 은 권한이 없어 못 보는 경우에도 False 를 준다. 그래서
        "없다" 와 "볼 수 없다" 를 구분하지 못한다.

        Let's Encrypt 인증서는 /etc/letsencrypt/live/ 에 있고 그 디렉토리는
        0700 root 다. install_nginx_stack.sh --check 는 sudo 없이 도는 경로라
        여기서 반드시 걸리는데, 파일은 멀쩡히 있다. 없다고 단정하고 죽으면
        멀쩡한 설정을 틀렸다고 말하는 셈이다.
        """
        try:
            os.stat(path)
            return "ok"
        except FileNotFoundError:
            return "missing"
        except OSError:
            # PermissionError 를 포함한다 — 상위 디렉토리를 지나갈 수 없는 경우다.
            return "unknown"

    def report_certificate(self):
        """어느 인증서로 갈렸는지, 왜 그렇게 갈렸는지 반드시 남긴다.

        **조용히 사설로 떨어지는 것이 가장 나쁘다.** 서버는 멀쩡히 뜨고
        브라우저만 경고를 내므로, 앱이 안 붙는다는 신고가 올 때까지 아무도
        모른다. 그래서 판정과 이유를 항상 한 줄씩 남긴다.

        판정 자체는 막지 않는다. 사설 CA 는 LAN 전용 배치에서 옳은 선택이고,
        도메인이 없거나 80 을 열 수 없는 장비가 실재한다. 잘못된 것이 아니라
        **선택된 것**이므로 problem 이 아니라 skip 이다 (docs/check-contract.md).
        """
        if self.cert_half_declared:
            judge("problem",
                  "[tls] cert_file 과 key_file 중 하나만 적혀 있습니다 — "
                  "둘 다 적거나 둘 다 비우세요. 한쪽만 적으면 공인 인증서에 사설 "
                  "개인키가 짝지어져 nginx 가 'key values mismatch' 로 거절합니다")
            print("  !!      [tls] cert_file 과 key_file 중 하나만 적혀 있습니다", file=sys.stderr)

        if self.cert_declared:
            judge("ok", f"서버 인증서: {self.cert} (nginx-stack.conf 에 직접 적은 값)")
            print(f"  ok      서버 인증서 {self.cert}", file=sys.stderr)
            print("            (nginx-stack.conf 의 [tls] 에 직접 적힌 값이라 tls_mode 를 보지 않습니다)",
                  file=sys.stderr)
            return

        if self.tls_mode == "public":
            judge("ok", f"서버 인증서: 공인 — {self.cert} · {self.tls_mode_reason}")
            print(f"  ok      서버 인증서 공인 — {self.cert}", file=sys.stderr)
            print(f"            {self.tls_mode_reason}", file=sys.stderr)
            return

        judge("skip",
              f"서버 인증서: 사설 CA — {self.cert} · {self.tls_mode_reason}. "
              "공인으로 옮기려면 site/settings.ini 의 tls_mode 와 nginx/public_ca/ 를 보세요")
        print(f"  --      서버 인증서 사설 CA — {self.cert}", file=sys.stderr)
        print(f"            {self.tls_mode_reason}", file=sys.stderr)

    def check_files(self):
        paths = [self.cert, self.key]
        if self.client_ca and self.verify_client:
            paths.append(self.client_ca)

        missing, unknown = [], []
        for p in paths:
            state = self._file_state(p)
            if state == "missing":
                missing.append(p)
            elif state == "unknown":
                unknown.append(p)

        if missing:
            die("인증서 파일이 없습니다:\n  " + "\n  ".join(missing))

        if unknown:
            # 막지 않는다. root 로 도는 nginx -t 가 진짜 관문이고, 그쪽은 읽을 수 있다.
            print("  --      인증서를 확인할 수 없습니다 (권한). root 로 실행하면 확인합니다:",
                  file=sys.stderr)
            for p in unknown:
                print(f"            {p}", file=sys.stderr)

    def acme_challenge_block(self):
        """Let's Encrypt HTTP-01 챌린지 예외.

        80 포트 서버는 조건 없이 301 로 HTTPS 에 넘긴다. 그 앞에 이 location 을
        두어 챌린지 경로만 평문으로 응답하게 한다. Let's Encrypt 는 반드시 80 으로
        들어오고 포트를 지정할 수 없어서, 이 자리가 없으면 검증이 통과하지 못한다.

        `^~` 로 잡아 접두사 일치 즉시 확정시킨다. 그리고 리다이렉트 쪽도
        location 안에 있어야 한다 — server 레벨의 `return` 은 location 을 고르기
        전 단계에서 실행되므로, 밖에 두면 이 예외에 닿지도 못하고 301 이 나간다.

        acme_webroot 를 비우면 아무것도 만들지 않는다 — 예전 동작 그대로다.
        """
        if not self.acme_webroot:
            return ""
        return (
            "\n    # Let's Encrypt HTTP-01. 아래 location / 의 301 보다 구체적이라 먼저 잡힌다.\n"
            f"    location ^~ /.well-known/acme-challenge/ {{\n"
            f"        root {self.acme_webroot};\n"
            "        default_type \"text/plain\";\n"
            "        try_files $uri =404;\n"
            "    }\n"
        )

    def redirect_map(self):
        """공유기 포트 포워딩 대응.

        외부 HTTP 포트로 들어온 요청을 HTTPS 로 보낼 때 목적지는 내부 443 이
        아니라 외부에 열려 있는 HTTPS 포트여야 한다. nginx 는 공유기의 포트
        대응을 알 수 없으므로 Host 의 포트를 보고 구분한다.
        """
        if not (self.public_http_port and self.public_https_port):
            return "", "$host"

        block = (
            "\n# 외부(포워딩) 접속과 내부 접속을 구분해 HTTPS 목적지를 정한다.\n"
            f"# 외부 {self.public_http_port} -> 내부 {self.listen_port}, "
            f"외부 {self.public_https_port} -> 내부 {self.ssl_port}\n"
            "map $http_host $public_https_host {\n"
            "    default              $host;\n"
            f'    "~:{self.public_http_port}$"  $host:{self.public_https_port};\n'
            "}\n"
        )
        return block, "$public_https_host"

    def client_verify_block(self):
        if not (self.client_ca and self.verify_client):
            return ""
        return (
            f"\n    ssl_client_certificate {self.client_ca};\n"
            f"    ssl_verify_client {self.verify_client};\n"
        )

    def default_route_block(self):
        """'= /' 는 정확히 '/' 만 매치하므로 다른 경로에는 영향이 없다."""
        if not self.default_route:
            return ""
        return (
            "\n    # 기본 라우트\n"
            "    location = / {\n"
            f"        return 302 {self.default_route};\n"
            "    }\n"
        )

    def max_body_block(self):
        if not self.max_body:
            return ""
        return f"\n    client_max_body_size {self.max_body};\n"


def render(stack, services, template_text):
    upstreams = "\n\n".join(s.render_upstream() for s in services)

    # 정규식 location 은 적힌 순서대로 검사되므로 order 가 결과를 바꾼다.
    # 같은 order 안에서는 서비스 이름 -> 라우트 키 순으로 안정 정렬한다.
    routes = [r for s in services for r in s.routes]
    routes.sort(key=lambda r: (r.order, r.service.name, r.key))
    locations = "\n\n".join(r.render() for r in routes)

    redirect_map, https_redirect_host = stack.redirect_map()

    output = template_text
    for placeholder, value in (
        ("__REDIRECT_MAP__", redirect_map),
        ("__UPSTREAMS__", "\n" + upstreams if upstreams else ""),
        ("__LOCATIONS__", locations),
        ("__LISTEN_PORT__", stack.listen_port),
        ("__SSL_PORT__", stack.ssl_port),
        ("__SERVER_NAME__", stack.server_name),
        ("__HTTPS_REDIRECT_HOST__", https_redirect_host),
        ("__SSL_CERTIFICATE_KEY__", stack.key),
        ("__SSL_CERTIFICATE__", stack.cert),
        ("__MAX_BODY__", stack.max_body_block()),
        ("__SSL_CLIENT_VERIFY__", stack.client_verify_block()),
        ("__ACME_CHALLENGE__", stack.acme_challenge_block()),
        ("__DEFAULT_ROUTE__", stack.default_route_block()),
    ):
        output = output.replace(placeholder, value)

    leftover = re.findall(r"__[A-Z_]+__", output)
    if leftover:
        die(f"템플릿에 치환되지 않은 자리표시자가 남았습니다: {', '.join(sorted(set(leftover)))}")

    return output


def check_installed(stack, services, template_path, installed_path):
    """설치본이 **지금 선언대로 만든 것**과 같은가.

    선언(nginx-conf/*.ini)만 보는 검사는 "선언은 고쳤는데 반영을 안 한" 상태를
    잡지 못한다. 그때 nginx 는 옛 라우트를 그대로 서비스하고 있고, 화면 어디에도
    오류로 보이지 않는다. 그래서 만들어질 내용과 설치본을 맞춰 본다.

    판정은 pending 이다 — 고장이 아니라 아직 반영하지 않은 것이기 때문이다.
    (docs/check-contract.md 의 '설치본이 저장소와 같은가')
    """
    if not os.path.exists(installed_path):
        judge("pending", f"{installed_path} 가 없습니다 — 아직 반영한 적이 없습니다")
        print(f"  --      {installed_path} 없음", file=sys.stderr)
        return

    try:
        with open(installed_path, encoding="utf-8") as handle:
            current = handle.read()
        with open(template_path, encoding="utf-8") as handle:
            template_text = handle.read()
    except OSError as err:
        # 못 읽은 것을 "다르다" 로 보고하면 안 된다 (권한일 뿐이다).
        judge("skip", f"{installed_path} 를 읽지 못해 비교를 건너뜁니다 ({err.strerror})")
        return

    expected = render(stack, services, template_text)
    if expected == current:
        judge("ok", f"설치본이 지금 선언과 같습니다: {installed_path}")
        print(f"  ok      {installed_path} 최신", file=sys.stderr)
        return

    delta = list(difflib.unified_diff(expected.splitlines(), current.splitlines(), n=0))
    changed = sum(1 for line in delta if line[:1] in "+-" and line[:3] not in ("+++", "---"))
    judge("pending",
          f"설치본이 지금 선언과 다릅니다 ({changed}줄) — 반영하세요: "
          f"sudo ./install_nginx_stack.sh --skip-install")
    print(f"  --      {installed_path} 가 선언보다 낡았습니다 ({changed}줄)", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--config", default=os.path.join(HERE, "nginx-stack.conf"))
    parser.add_argument("--template", default=os.path.join(HERE, "server.conf.template"))
    parser.add_argument("--output", help="쓸 파일 경로. 없으면 표준 출력")
    parser.add_argument("--check", action="store_true", help="파싱과 충돌 검사만 하고 끝낸다")
    parser.add_argument("--json", action="store_true",
                        help="점검 결과를 기계가 읽는 형식으로 낸다 (docs/check-contract.md)")
    parser.add_argument("--installed", default=INSTALLED_CONF,
                        help="설치본 경로. 지금 선언과 같은지 비교한다")
    args = parser.parse_args()

    global CHECK_JSON
    CHECK_JSON = args.json

    stack = Stack(args.config)

    if not os.path.isdir(stack.services_dir):
        die(f"서비스 디렉토리가 없습니다: {stack.services_dir}")

    print(f"Scanning {stack.services_dir}/*/nginx-conf/*.ini", file=sys.stderr)
    services = load_services(stack.services_dir)

    if not services:
        die(f"nginx-conf/*.ini 를 하나도 찾지 못했습니다: {stack.services_dir}")

    check_conflicts(services)
    stack.report_certificate()
    stack.check_files()

    for service in services:
        ports = " ".join(str(p) for p in service.ports)
        routes = ", ".join(r.match_key for r in service.routes) or "(라우트 없음)"
        judge("ok", f"{service.name} — {ports} {routes}")
        print(f"  ok      {service.name:18} {ports:12} {routes}", file=sys.stderr)

    # 선언이 옳은가 다음에, 그것이 실제로 반영돼 있는가를 본다.
    check_installed(stack, services, args.template, args.installed)

    check_finish()      # --json 이면 여기서 끝난다

    if args.check:
        print(f"{len(services)} services, no conflicts.", file=sys.stderr)
        return

    try:
        with open(args.template, encoding="utf-8") as handle:
            template_text = handle.read()
    except OSError as err:
        die(f"템플릿을 읽을 수 없습니다: {err}")

    output = render(stack, services, template_text)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(output)
        print(f"Wrote {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(output)


if __name__ == "__main__":
    main()
