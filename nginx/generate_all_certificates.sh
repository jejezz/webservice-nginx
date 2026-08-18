#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DOMAIN="callfusion.ptype.co.kr"
SERVER_IP="10.10.0.224"
ORGANIZATION="Apartment Complex"
COUNTRY="KR"
STATE="Seoul"
CITY="Seoul"
CA_DAYS=1825
SERVER_DAYS=365
CLIENT_DAYS=365
P12_PASSWORD="changeit"
CLIENT_CN="client.local"

CERT_DIR="${SCRIPT_DIR}/certs"
BACKUP_DIR="${CERT_DIR}/backup_$(date +%Y%m%d_%H%M%S)"

usage() {
  cat <<'EOF'
Usage: ./generate_all_certificates.sh [options]

Generates a complete certificate chain: CA -> server cert + client certs.
Outputs bundles for NGINX, Android, and Electron.

Options:
  --domain NAME          Server domain name (default: callfusion.ptype.co.kr)
  --ip ADDRESS           Server IP address (default: 10.10.0.24)
  --organization NAME    Organization (default: Apartment Complex)
  --ca-days N            CA validity days (default: 1825 = 5 years)
  --server-days N        Server cert validity days (default: 365)
  --client-days N        Client cert validity days (default: 365)
  --client-cn NAME       Client cert CN (default: client.local)
  --p12-password PASS    PKCS12 password (default: changeit)
  -h, --help             Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)       DOMAIN="${2:-}";       shift 2 ;;
    --ip)           SERVER_IP="${2:-}";     shift 2 ;;
    --organization) ORGANIZATION="${2:-}"; shift 2 ;;
    --ca-days)      CA_DAYS="${2:-}";       shift 2 ;;
    --server-days)  SERVER_DAYS="${2:-}";   shift 2 ;;
    --client-days)  CLIENT_DAYS="${2:-}";   shift 2 ;;
    --client-cn)    CLIENT_CN="${2:-}";     shift 2 ;;
    --p12-password) P12_PASSWORD="${2:-}";  shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required but not installed." >&2
  exit 1
fi

umask 077

echo "=== Backing up existing certificates ==="
mkdir -p "$BACKUP_DIR"
for f in "$CERT_DIR"/*.pem "$CERT_DIR"/*.crt "$CERT_DIR"/*.key; do
  [[ -f "$f" ]] && cp "$f" "$BACKUP_DIR/" && echo "  backed up: $(basename "$f")"
done

echo ""
echo "=== Step 1: Generate CA ==="

CA_KEY="${CERT_DIR}/ca_key.pem"
CA_CERT="${CERT_DIR}/ca_cert.pem"
CA_SUBJECT="/C=${COUNTRY}/ST=${STATE}/L=${CITY}/O=${ORGANIZATION}/CN=${ORGANIZATION} CA"

openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
echo "  CA private key: ${CA_KEY}"

openssl req -x509 -new -nodes \
  -key "$CA_KEY" \
  -sha256 \
  -days "$CA_DAYS" \
  -out "$CA_CERT" \
  -subj "$CA_SUBJECT" \
  2>/dev/null
echo "  CA certificate:  ${CA_CERT}"

echo ""
echo "=== Step 2: Generate server certificate (signed by CA) ==="

SERVER_KEY="${CERT_DIR}/key.pem"
SERVER_CSR="${CERT_DIR}/server.csr"
SERVER_CERT="${CERT_DIR}/cert.pem"
SERVER_SUBJECT="/C=${COUNTRY}/ST=${STATE}/L=${CITY}/O=${ORGANIZATION}/CN=${DOMAIN}"

SERVER_EXT_FILE=$(mktemp)
cat > "$SERVER_EXT_FILE" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature, keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:${DOMAIN},IP:${SERVER_IP}
EOF

openssl genrsa -out "$SERVER_KEY" 4096 2>/dev/null
echo "  Server private key: ${SERVER_KEY}"

openssl req -new \
  -key "$SERVER_KEY" \
  -out "$SERVER_CSR" \
  -subj "$SERVER_SUBJECT" \
  2>/dev/null

openssl x509 -req \
  -in "$SERVER_CSR" \
  -CA "$CA_CERT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -out "$SERVER_CERT" \
  -days "$SERVER_DAYS" \
  -sha256 \
  -extfile "$SERVER_EXT_FILE" \
  2>/dev/null
echo "  Server certificate:  ${SERVER_CERT}"
echo "  SAN: DNS:${DOMAIN}, IP:${SERVER_IP}"

rm -f "$SERVER_CSR" "$SERVER_EXT_FILE" "${CERT_DIR}/ca_cert.srl"

echo ""
echo "=== Step 3: Generate client certificate (signed by CA) ==="

CLIENT_DIR="${CERT_DIR}/clients"
mkdir -p "$CLIENT_DIR"

CLIENT_KEY="${CLIENT_DIR}/client.key"
CLIENT_CSR="${CLIENT_DIR}/client.csr"
CLIENT_CERT="${CLIENT_DIR}/client.crt"
CLIENT_PEM="${CLIENT_DIR}/client.pem"
CLIENT_P12="${CLIENT_DIR}/client.p12"
CLIENT_SUBJECT="/C=${COUNTRY}/ST=${STATE}/L=${CITY}/O=${ORGANIZATION}/CN=${CLIENT_CN}"

CLIENT_EXT_FILE=$(mktemp)
cat > "$CLIENT_EXT_FILE" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature, keyEncipherment
extendedKeyUsage=clientAuth
EOF

openssl genrsa -out "$CLIENT_KEY" 2048 2>/dev/null
echo "  Client private key: ${CLIENT_KEY}"

openssl req -new \
  -key "$CLIENT_KEY" \
  -out "$CLIENT_CSR" \
  -subj "$CLIENT_SUBJECT" \
  2>/dev/null

openssl x509 -req \
  -in "$CLIENT_CSR" \
  -CA "$CA_CERT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -out "$CLIENT_CERT" \
  -days "$CLIENT_DAYS" \
  -sha256 \
  -extfile "$CLIENT_EXT_FILE" \
  2>/dev/null
echo "  Client certificate:  ${CLIENT_CERT}"

cat "$CLIENT_CERT" "$CLIENT_KEY" > "$CLIENT_PEM"
echo "  Client PEM bundle:   ${CLIENT_PEM}"

openssl pkcs12 -export \
  -out "$CLIENT_P12" \
  -inkey "$CLIENT_KEY" \
  -in "$CLIENT_CERT" \
  -certfile "$CA_CERT" \
  -name "$CLIENT_CN" \
  -passout "pass:${P12_PASSWORD}" \
  2>/dev/null
echo "  Client PKCS12:       ${CLIENT_P12}"

cp "$CA_CERT" "${CLIENT_DIR}/ca.crt"

rm -f "$CLIENT_CSR" "$CLIENT_EXT_FILE" "${CERT_DIR}/ca_cert.srl"

echo ""
echo "=== Step 4: Create platform bundles ==="

ANDROID_DIR="${CERT_DIR}/android"
ELECTRON_DIR="${CERT_DIR}/electron"
mkdir -p "$ANDROID_DIR" "$ELECTRON_DIR"

cp "$CA_CERT" "${ANDROID_DIR}/ca_cert.pem"
cp "$CLIENT_P12" "${ANDROID_DIR}/client.p12"
echo "  Android: ${ANDROID_DIR}/ca_cert.pem, client.p12"

cat > "${ANDROID_DIR}/network_security_config.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="true">${DOMAIN}</domain>
        <domain includeSubdomains="true">${SERVER_IP}</domain>
        <trust-anchors>
            <certificates src="@raw/ca_cert" />
        </trust-anchors>
    </domain-config>
</network-security-config>
EOF
echo "  Android: ${ANDROID_DIR}/network_security_config.xml"

cp "$CA_CERT" "${ELECTRON_DIR}/ca_cert.pem"
cp "$CLIENT_CERT" "${ELECTRON_DIR}/client.crt"
cp "$CLIENT_KEY" "${ELECTRON_DIR}/client.key"
cp "$CLIENT_PEM" "${ELECTRON_DIR}/client.pem"
echo "  Electron: ${ELECTRON_DIR}/ca_cert.pem, client.crt, client.key, client.pem"

echo ""
echo "=== Step 5: Verify certificate chain ==="
echo ""

echo "CA -> Server cert chain:"
openssl verify -CAfile "$CA_CERT" "$SERVER_CERT" 2>&1 | sed 's/^/  /'

echo "CA -> Client cert chain:"
openssl verify -CAfile "$CA_CERT" "$CLIENT_CERT" 2>&1 | sed 's/^/  /'

echo ""
echo "Server certificate SAN:"
openssl x509 -in "$SERVER_CERT" -noout -ext subjectAltName 2>&1 | sed 's/^/  /'

echo ""
echo "Server certificate validity:"
openssl x509 -in "$SERVER_CERT" -noout -dates 2>&1 | sed 's/^/  /'

echo ""
cat <<EOF
=== Complete ===

Certificate chain:
  CA cert:      ${CA_CERT}
  CA key:       ${CA_KEY}  (keep secret!)
  Server cert:  ${SERVER_CERT}
  Server key:   ${SERVER_KEY}

NGINX config (nginx-stack.conf [tls] section):
  cert_dir=./certs
  cert_file=cert.pem
  key_file=key.pem

Android client files:
  ${ANDROID_DIR}/ca_cert.pem              -> res/raw/ca_cert.pem
  ${ANDROID_DIR}/client.p12               -> assets/client.p12
  ${ANDROID_DIR}/network_security_config.xml -> res/xml/

Electron client files:
  ${ELECTRON_DIR}/ca_cert.pem             -> trust anchor for TLS verification
  ${ELECTRON_DIR}/client.crt              -> client certificate
  ${ELECTRON_DIR}/client.key              -> client private key

PKCS12 password: ${P12_PASSWORD}
Backup: ${BACKUP_DIR}
EOF
