#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="${SCRIPT_DIR}/cert"

# 기본값
DAYS_CA=3650
DAYS_SERVER=365
DAYS_CLIENT=365
RSA_BITS=2048

usage() {
    echo "Usage: $0 [options] [domain]"
    echo ""
    echo "  domain               서버 도메인 (기본값: localhost)"
    echo ""
    echo "Options:"
    echo "  --auto               로컬 IP + 외부 IP 자동 감지하여 추가"
    echo "  --ip <ip>            허용할 IP 추가 (여러 번 사용 가능)"
    echo "  --ip <ip1,ip2,...>   쉼표로 구분하여 여러 IP 한번에 추가"
    echo "  --dns <domain>       허용할 도메인 추가 (여러 번 사용 가능)"
    echo "  -h, --help           도움말"
    echo ""
    echo "Examples:"
    echo "  $0 --auto                                   # 자동 IP 감지 + localhost"
    echo "  $0 --auto example.com                       # 자동 IP 감지 + 도메인"
    echo "  $0 --auto --ip 10.0.0.50 example.com        # 자동 + 수동 IP 추가"
    echo "  $0 --ip 192.168.0.10 example.com            # IP 1개 추가"
    echo "  $0 --ip 192.168.0.10,192.168.0.11,10.0.0.1  # IP 여러개 추가"
    exit 1
}

DOMAIN=""
EXTRA_IPS=()
EXTRA_DNS=()
AUTO_DETECT=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            ;;
        --auto)
            AUTO_DETECT=true
            shift
            ;;
        --ip)
            shift
            IFS=',' read -ra _ips <<< "$1"
            for _ip in "${_ips[@]}"; do
                _ip="$(echo "$_ip" | xargs)"
                [[ -n "$_ip" ]] && EXTRA_IPS+=("$_ip")
            done
            shift
            ;;
        --dns)
            shift
            IFS=',' read -ra _dns <<< "$1"
            for _d in "${_dns[@]}"; do
                _d="$(echo "$_d" | xargs)"
                [[ -n "$_d" ]] && EXTRA_DNS+=("$_d")
            done
            shift
            ;;
        *)
            DOMAIN="$1"
            shift
            ;;
    esac
done

DOMAIN="${DOMAIN:-localhost}"

if [[ "$AUTO_DETECT" == true ]]; then
    echo "Detecting IP addresses..."

    # 로컬 IPv4 주소 (루프백, docker/veth 제외)
    while IFS= read -r ip; do
        [[ -z "$ip" ]] && continue
        EXTRA_IPS+=("$ip")
        echo "  Local IP: ${ip}"
    done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' | grep -v '^172\.1[7-9]\.' | grep -v '^172\.2[0-9]\.' | grep -v '^172\.3[0-1]\.')

    # 외부 IP
    external_ip=""
    external_ip="$(curl -s --max-time 5 ifconfig.me 2>/dev/null)" || \
    external_ip="$(curl -s --max-time 5 api.ipify.org 2>/dev/null)" || \
    external_ip="$(curl -s --max-time 5 checkip.amazonaws.com 2>/dev/null)" || true

    if [[ -n "$external_ip" ]]; then
        EXTRA_IPS+=("$external_ip")
        echo "  External IP: ${external_ip}"
    else
        echo "  External IP: (감지 실패 - 스킵)"
    fi

    echo ""
fi

echo "=== Certificate Generation ==="
echo "Domain: ${DOMAIN}"
if [[ ${#EXTRA_IPS[@]} -gt 0 ]]; then
    echo "Extra IPs: ${EXTRA_IPS[*]}"
fi
if [[ ${#EXTRA_DNS[@]} -gt 0 ]]; then
    echo "Extra DNS: ${EXTRA_DNS[*]}"
fi
echo "Output: ${CERT_DIR}"
echo ""

# 디렉토리 생성
mkdir -p "${CERT_DIR}/ca"
mkdir -p "${CERT_DIR}/server"
mkdir -p "${CERT_DIR}/client/electron"
mkdir -p "${CERT_DIR}/client/android"
mkdir -p "${CERT_DIR}/client/ios"

# ============================================================
# 1. CA (Certificate Authority)
# ============================================================
echo "[1/4] Generating CA certificate..."

openssl genrsa -out "${CERT_DIR}/ca/ca.key" ${RSA_BITS} 2>/dev/null

openssl req -new -x509 \
    -key "${CERT_DIR}/ca/ca.key" \
    -out "${CERT_DIR}/ca/ca.crt" \
    -days ${DAYS_CA} \
    -subj "/C=KR/ST=Seoul/O=DevCA/CN=DevCA Root"

echo "  -> ca/ca.key, ca/ca.crt"

# ============================================================
# 2. Server Certificate
# ============================================================
echo "[2/4] Generating server certificate..."

{
    cat <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names

[alt_names]
EOF

    dns_idx=1
    ip_idx=1

    echo "DNS.${dns_idx} = ${DOMAIN}"; ((dns_idx++))
    echo "DNS.${dns_idx} = *.${DOMAIN}"; ((dns_idx++))
    if [[ "$DOMAIN" != "localhost" ]]; then
        echo "DNS.${dns_idx} = localhost"; ((dns_idx++))
    fi
    for d in "${EXTRA_DNS[@]+"${EXTRA_DNS[@]}"}"; do
        [[ -z "$d" ]] && continue
        echo "DNS.${dns_idx} = ${d}"; ((dns_idx++))
    done

    echo "IP.${ip_idx} = 127.0.0.1"; ((ip_idx++))
    echo "IP.${ip_idx} = ::1"; ((ip_idx++))
    for ip in "${EXTRA_IPS[@]+"${EXTRA_IPS[@]}"}"; do
        [[ -z "$ip" ]] && continue
        echo "IP.${ip_idx} = ${ip}"; ((ip_idx++))
    done
} > "${CERT_DIR}/server/server.ext"

openssl genrsa -out "${CERT_DIR}/server/server.key" ${RSA_BITS} 2>/dev/null

openssl req -new \
    -key "${CERT_DIR}/server/server.key" \
    -out "${CERT_DIR}/server/server.csr" \
    -subj "/C=KR/ST=Seoul/O=DevServer/CN=${DOMAIN}"

openssl x509 -req \
    -in "${CERT_DIR}/server/server.csr" \
    -CA "${CERT_DIR}/ca/ca.crt" \
    -CAkey "${CERT_DIR}/ca/ca.key" \
    -CAcreateserial \
    -out "${CERT_DIR}/server/server.crt" \
    -days ${DAYS_SERVER} \
    -extfile "${CERT_DIR}/server/server.ext" 2>/dev/null

rm -f "${CERT_DIR}/server/server.csr" "${CERT_DIR}/server/server.ext"

echo "  -> server/server.key, server/server.crt"

# ============================================================
# 3. Client Certificate 생성 함수
# ============================================================
generate_client_cert() {
    local name="$1"
    local cn="$2"
    local out_dir="${CERT_DIR}/client/${name}"

    openssl genrsa -out "${out_dir}/${name}.key" ${RSA_BITS} 2>/dev/null

    openssl req -new \
        -key "${out_dir}/${name}.key" \
        -out "${out_dir}/${name}.csr" \
        -subj "/C=KR/ST=Seoul/O=DevClient/CN=${cn}"

    cat > "${out_dir}/${name}.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=clientAuth
EOF

    openssl x509 -req \
        -in "${out_dir}/${name}.csr" \
        -CA "${CERT_DIR}/ca/ca.crt" \
        -CAkey "${CERT_DIR}/ca/ca.key" \
        -CAcreateserial \
        -out "${out_dir}/${name}.crt" \
        -days ${DAYS_CLIENT} \
        -extfile "${out_dir}/${name}.ext" 2>/dev/null

    # PEM bundle (key + cert)
    cat "${out_dir}/${name}.key" "${out_dir}/${name}.crt" > "${out_dir}/${name}.pem"

    # PKCS12 (.p12) — Android, iOS, Electron 모두 사용 가능
    openssl pkcs12 -export \
        -in "${out_dir}/${name}.crt" \
        -inkey "${out_dir}/${name}.key" \
        -certfile "${CERT_DIR}/ca/ca.crt" \
        -out "${out_dir}/${name}.p12" \
        -passout pass: \
        -legacy 2>/dev/null || \
    openssl pkcs12 -export \
        -in "${out_dir}/${name}.crt" \
        -inkey "${out_dir}/${name}.key" \
        -certfile "${CERT_DIR}/ca/ca.crt" \
        -out "${out_dir}/${name}.p12" \
        -passout pass: 2>/dev/null

    rm -f "${out_dir}/${name}.csr" "${out_dir}/${name}.ext"
}

# ============================================================
# 4. Client Certificates
# ============================================================
echo "[3/4] Generating client certificates..."

generate_client_cert "electron" "Electron Client"
echo "  -> client/electron/ (.key, .crt, .pem, .p12)"

generate_client_cert "android" "Android Client"
echo "  -> client/android/ (.key, .crt, .pem, .p12)"

generate_client_cert "ios" "iOS Client"
echo "  -> client/ios/ (.key, .crt, .pem, .p12)"

# ============================================================
# 5. CA 인증서를 각 클라이언트 디렉토리에 복사
# ============================================================
echo "[4/4] Distributing CA certificate to client directories..."

cp "${CERT_DIR}/ca/ca.crt" "${CERT_DIR}/client/electron/ca.crt"
cp "${CERT_DIR}/ca/ca.crt" "${CERT_DIR}/client/android/ca.crt"
cp "${CERT_DIR}/ca/ca.crt" "${CERT_DIR}/client/ios/ca.crt"

# ============================================================
# 시리얼 파일 정리
# ============================================================
rm -f "${CERT_DIR}/ca/ca.srl"

# ============================================================
# 결과 요약
# ============================================================
echo ""
echo "=== Generated Certificate Structure ==="
echo ""
echo "cert/"
echo "├── ca/"
echo "│   ├── ca.key              # CA 개인키 (보관 주의)"
echo "│   └── ca.crt              # CA 인증서 (클라이언트에 신뢰 등록)"
echo "├── server/"
echo "│   ├── server.key          # 서버 개인키"
echo "│   └── server.crt          # 서버 인증서 (Nginx용)"
echo "└── client/"
echo "    ├── electron/"
echo "    │   ├── electron.key    # 개인키"
echo "    │   ├── electron.crt    # 인증서"
echo "    │   ├── electron.pem    # PEM bundle (key+cert)"
echo "    │   ├── electron.p12    # PKCS12 (password: 빈값)"
echo "    │   └── ca.crt          # CA 인증서"
echo "    ├── android/"
echo "    │   ├── android.key"
echo "    │   ├── android.crt"
echo "    │   ├── android.pem"
echo "    │   ├── android.p12     # Android: 이 파일 사용"
echo "    │   └── ca.crt"
echo "    └── ios/"
echo "        ├── ios.key"
echo "        ├── ios.crt"
echo "        ├── ios.pem"
echo "        ├── ios.p12         # iOS: 이 파일 사용"
echo "        └── ca.crt"
echo ""
echo "=== Next Steps ==="
echo "1. nginx.ini의 인증서 경로를 업데이트하세요 (또는 자동 업데이트됨)"
echo "2. sudo ./setup_nginx.sh 를 실행하여 Nginx에 적용하세요"
echo "3. 클라이언트 기기에 ca.crt를 신뢰할 수 있는 인증서로 등록하세요"
