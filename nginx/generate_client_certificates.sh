#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/certs/clients/generated-$(date +%Y%m%d-%H%M%S)"
CN="client.local"
ORGANIZATION="Apartment Complex"
COUNTRY="KR"
STATE="Seoul"
CITY="Seoul"
DAYS=365
P12_PASSWORD="changeit"

usage() {
  cat <<'EOF'
Usage: ./generate_client_certificates.sh [options]

Generates client certificate bundles for web, Android, and iOS in one run.

Options:
  --out-dir PATH         Output directory (default: ./certs/clients/generated-<timestamp>)
  --cn NAME              Client certificate common name (default: client.local)
  --organization NAME    Organization in subject DN (default: Apartment Complex)
  --country CODE         Country code in subject DN (default: KR)
  --state NAME           State/province in subject DN (default: Seoul)
  --city NAME            City/locality in subject DN (default: Seoul)
  --days N               Certificate validity days (default: 365)
  --p12-password PASS    Password used for .p12 files (default: changeit)
  -h, --help             Show this help message

Examples:
  ./generate_client_certificates.sh
  ./generate_client_certificates.sh --cn web-mobile-client --p12-password 'my-secret'
  ./generate_client_certificates.sh --out-dir ./certs/clients/release-1
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --cn)
      CN="${2:-}"
      shift 2
      ;;
    --organization)
      ORGANIZATION="${2:-}"
      shift 2
      ;;
    --country)
      COUNTRY="${2:-}"
      shift 2
      ;;
    --state)
      STATE="${2:-}"
      shift 2
      ;;
    --city)
      CITY="${2:-}"
      shift 2
      ;;
    --days)
      DAYS="${2:-}"
      shift 2
      ;;
    --p12-password)
      P12_PASSWORD="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required but not installed." >&2
  exit 1
fi

if [[ -z "$OUT_DIR" ]]; then
  echo "Output directory cannot be empty." >&2
  exit 1
fi

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "--days must be a positive integer." >&2
  exit 1
fi

umask 077

SHARED_DIR="${OUT_DIR}/shared"
WEB_DIR="${OUT_DIR}/web"
ANDROID_DIR="${OUT_DIR}/android"
IOS_DIR="${OUT_DIR}/ios"

mkdir -p "$SHARED_DIR" "$WEB_DIR" "$ANDROID_DIR" "$IOS_DIR"

CA_KEY="${SHARED_DIR}/ca.key"
CA_CERT="${SHARED_DIR}/ca.crt"
CLIENT_KEY="${SHARED_DIR}/client.key"
CLIENT_CSR="${SHARED_DIR}/client.csr"
CLIENT_CERT="${SHARED_DIR}/client.crt"
CLIENT_CHAIN_PEM="${SHARED_DIR}/client.pem"
CLIENT_P12="${SHARED_DIR}/client.p12"

SUBJECT="/C=${COUNTRY}/ST=${STATE}/L=${CITY}/O=${ORGANIZATION}/CN=${CN}"
CA_SUBJECT="/C=${COUNTRY}/ST=${STATE}/L=${CITY}/O=${ORGANIZATION}/CN=${CN}-ca"

echo "Generating CA private key..."
openssl genrsa -out "$CA_KEY" 4096 >/dev/null 2>&1

echo "Generating CA certificate..."
openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days "$DAYS" -out "$CA_CERT" -subj "$CA_SUBJECT" >/dev/null 2>&1

echo "Generating client private key..."
openssl genrsa -out "$CLIENT_KEY" 2048 >/dev/null 2>&1

echo "Generating client CSR..."
openssl req -new -key "$CLIENT_KEY" -out "$CLIENT_CSR" -subj "$SUBJECT" >/dev/null 2>&1

echo "Signing client certificate with CA..."
openssl x509 -req -in "$CLIENT_CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial -out "$CLIENT_CERT" -days "$DAYS" -sha256 >/dev/null 2>&1

cat "$CLIENT_CERT" "$CLIENT_KEY" > "$CLIENT_CHAIN_PEM"

echo "Exporting PKCS#12 bundle..."
openssl pkcs12 -export \
  -out "$CLIENT_P12" \
  -inkey "$CLIENT_KEY" \
  -in "$CLIENT_CERT" \
  -certfile "$CA_CERT" \
  -name "$CN" \
  -passout "pass:${P12_PASSWORD}" >/dev/null 2>&1

# Web bundle
cp "$CA_CERT" "${WEB_DIR}/ca.crt"
cp "$CLIENT_CERT" "${WEB_DIR}/client.crt"
cp "$CLIENT_KEY" "${WEB_DIR}/client.key"
cp "$CLIENT_CHAIN_PEM" "${WEB_DIR}/client.pem"

# Android bundle
cp "$CA_CERT" "${ANDROID_DIR}/ca_cert.pem"
cp "$CLIENT_P12" "${ANDROID_DIR}/client.p12"

# iOS bundle
cp "$CA_CERT" "${IOS_DIR}/ca.crt"
openssl x509 -in "$CA_CERT" -outform der -out "${IOS_DIR}/ca.cer" >/dev/null 2>&1
cp "$CLIENT_P12" "${IOS_DIR}/client.p12"

rm -f "$CLIENT_CSR" "${SHARED_DIR}/ca.srl"

cat <<EOF
Certificate generation complete.

Output directory:
  ${OUT_DIR}

Shared files:
  ${CA_CERT}
  ${CLIENT_CERT}
  ${CLIENT_KEY}
  ${CLIENT_CHAIN_PEM}
  ${CLIENT_P12}

Platform bundles:
  Web:
    ${WEB_DIR}/ca.crt
    ${WEB_DIR}/client.crt
    ${WEB_DIR}/client.key
    ${WEB_DIR}/client.pem

  Android:
    ${ANDROID_DIR}/ca_cert.pem
    ${ANDROID_DIR}/client.p12

  iOS:
    ${IOS_DIR}/ca.crt
    ${IOS_DIR}/ca.cer
    ${IOS_DIR}/client.p12

PKCS#12 password:
  ${P12_PASSWORD}
EOF
