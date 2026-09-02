#!/usr/bin/env bash
#
# 단말 하나에 배포할 클라이언트 인증서 번들을 만든다.
#
# generate_certs.sh 와 나뉘는 자리가 여기다. 그쪽은 CA·서버·클라이언트를 **한
# 벌로 처음부터** 만든다 — 다시 돌리면 CA 가 새로 나므로 이미 배포한 단말이
# 전부 무효가 된다. 그래서 단말이 하나 늘 때마다 쓸 수 없다.
#
# 이 스크립트는 **이미 있는 CA 로 서명만** 한다. CA 와 서버 인증서는 건드리지
# 않는다. 단말이 늘어나는 것은 운영 중에 계속 생기는 일이므로, 그때마다 이것을
# 부른다.
#
#   ./generate_certs.sh --auto example.com        # 처음 한 번. CA·서버·기본 단말
#   ./generate_client_certificates.sh wallpad-102 # 단말이 늘 때마다
#
# ⚠️ 서명하는 CA 는 nginx 의 [tls] client_ca 가 가리키는 것과 **같아야** 한다.
#    다른 CA 로 서명하면 nginx 가 $ssl_client_verify 를 FAILED 로 넘기고, 그
#    사실은 백엔드 로그에만 남는다. 그래서 경로를 인자로 받지 않고 cert/ca/ 로
#    고정한다 — nginx-stack.conf 의 client_ca = ca/ca.crt 가 그 자리다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="${SCRIPT_DIR}/cert"
CA_DIR="${CERT_DIR}/ca"

# 기본값. generate_certs.sh 와 같은 값을 쓴다 — 두 스크립트가 만든 인증서가
# 같은 성격이어야 나중에 둘을 구분해서 다룰 일이 없다.
DAYS=365
RSA_BITS=2048
COUNTRY="KR"
STATE="Seoul"
CITY=""
ORGANIZATION="DevClient"
P12_PASSWORD=""
NAME=""
CN=""
OUT_DIR=""
FORCE=false

usage() {
    cat <<'EOF'
Usage: ./generate_client_certificates.sh [options] <name>

  <name>                단말 이름. cert/client/<name>/ 에 번들을 만든다

Options:
  --cn NAME             인증서 CN (기본값: <name>)
  --out-dir PATH        출력 위치 (기본값: cert/client/<name>)
  --days N              유효기간 (기본값: 365)
  --p12-password PASS   .p12 비밀번호 (기본값: 빈 값)
  --organization NAME   주체 DN 의 O (기본값: DevClient)
  --country CODE        주체 DN 의 C (기본값: KR)
  --state NAME          주체 DN 의 ST (기본값: Seoul)
  --city NAME           주체 DN 의 L (기본값: 없음)
  --force               같은 이름의 번들이 있어도 덮어쓴다
  -h, --help            도움말

Examples:
  ./generate_client_certificates.sh wallpad-102
  ./generate_client_certificates.sh --cn 'Intercom 3F' --days 730 intercom-3f
  ./generate_client_certificates.sh --p12-password 'secret' android-app

산출물 (out-dir 아래):
  <name>.key .crt .pem .p12    단말이 제시할 자격 증명
  ca.crt                        PEM. Android network_security_config · 웹
  ca.cer                        DER. iOS 프로파일이 이 형식을 요구한다
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)       usage; exit 0 ;;
        --cn)            CN="${2:-}";            shift 2 ;;
        --out-dir)       OUT_DIR="${2:-}";       shift 2 ;;
        --days)          DAYS="${2:-}";          shift 2 ;;
        --p12-password)  P12_PASSWORD="${2:-}";  shift 2 ;;
        --organization)  ORGANIZATION="${2:-}";  shift 2 ;;
        --country)       COUNTRY="${2:-}";       shift 2 ;;
        --state)         STATE="${2:-}";         shift 2 ;;
        --city)          CITY="${2:-}";          shift 2 ;;
        --force)         FORCE=true;             shift ;;
        -*)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
        *)
            if [[ -n "$NAME" ]]; then
                echo "단말 이름은 하나만 받습니다: '$NAME' 과 '$1'" >&2
                exit 2
            fi
            NAME="$1"
            shift
            ;;
    esac
done

if [[ -z "$NAME" ]]; then
    echo "단말 이름이 필요합니다." >&2
    echo "" >&2
    usage >&2
    exit 2
fi

# 파일 이름과 디렉토리 이름이 되므로 좁게 잡는다.
if ! [[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "단말 이름은 영숫자로 시작하고 [A-Za-z0-9._-] 만 씁니다: '${NAME}'" >&2
    exit 2
fi

if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || [[ "$DAYS" -eq 0 ]]; then
    echo "--days 는 1 이상의 정수여야 합니다: '${DAYS}'" >&2
    exit 2
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl 이 필요합니다." >&2
    exit 1
fi

CN="${CN:-$NAME}"
OUT_DIR="${OUT_DIR:-${CERT_DIR}/client/${NAME}}"

# ⚠️ CA 가 없으면 여기서 멈춘다. 없다고 새로 만들면 안 된다 —
#    nginx 가 검증에 쓰는 CA 와 갈라져서, 단말은 인증서를 가졌는데 서버가
#    거절하는 상태가 된다. 그 증상은 TLS 단계에서 나므로 앱 로그에 안 남는다.
if [[ ! -f "${CA_DIR}/ca.crt" || ! -f "${CA_DIR}/ca.key" ]]; then
    echo "CA 가 없습니다: ${CA_DIR}/ca.crt · ca.key" >&2
    echo "" >&2
    echo "먼저 CA 와 서버 인증서를 만드세요:" >&2
    echo "  ./generate_certs.sh --auto <도메인>" >&2
    echo "" >&2
    echo "이미 배포한 단말이 있다면 CA 를 다시 만들지 마세요 — 전부 무효가 됩니다." >&2
    echo "백업에서 cert/ca/ 를 되돌리는 것이 먼저입니다." >&2
    exit 1
fi

if [[ -e "$OUT_DIR" && "$FORCE" != true ]]; then
    echo "이미 있습니다: ${OUT_DIR}" >&2
    echo "덮어쓰려면 --force. 다른 단말이면 다른 이름을 쓰세요." >&2
    echo "(같은 이름으로 다시 발급하면 그 단말에 배포한 이전 번들이 남아 두 벌이 됩니다)" >&2
    exit 1
fi

# 개인키가 나온다. 만들어지는 순간부터 좁혀 둔다.
umask 077
mkdir -p "$OUT_DIR"

SUBJECT="/C=${COUNTRY}/ST=${STATE}"
[[ -n "$CITY" ]] && SUBJECT="${SUBJECT}/L=${CITY}"
SUBJECT="${SUBJECT}/O=${ORGANIZATION}/CN=${CN}"

echo "=== Client Certificate ==="
echo "Name:    ${NAME}"
echo "Subject: ${SUBJECT}"
echo "CA:      ${CA_DIR}/ca.crt"
echo "Days:    ${DAYS}"
echo "Output:  ${OUT_DIR}"
echo ""

echo "[1/3] Generating client key and CSR..."
openssl genrsa -out "${OUT_DIR}/${NAME}.key" ${RSA_BITS} 2>/dev/null

openssl req -new \
    -key "${OUT_DIR}/${NAME}.key" \
    -out "${OUT_DIR}/${NAME}.csr" \
    -subj "$SUBJECT"

# extendedKeyUsage=clientAuth 가 핵심이다. serverAuth 만 든 인증서를 내밀면
# nginx 가 거절한다.
cat > "${OUT_DIR}/${NAME}.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=clientAuth
EOF

echo "[2/3] Signing with CA..."
# -CAcreateserial 은 ca.srl 이 없을 때만 만든다. 그 파일을 지우지 않는 것이
# generate_certs.sh 와 다른 점이다 — 그쪽은 한 번에 다 만들고 끝나지만 이쪽은
# 같은 CA 로 계속 발급하므로, 일련번호가 겹치면 나중에 개별 폐기(CRL)를 걸 수
# 없다. cert/ 는 통째로 .gitignore 에 있으니 남겨도 새지 않는다.
openssl x509 -req \
    -in "${OUT_DIR}/${NAME}.csr" \
    -CA "${CA_DIR}/ca.crt" \
    -CAkey "${CA_DIR}/ca.key" \
    -CAcreateserial \
    -out "${OUT_DIR}/${NAME}.crt" \
    -days "${DAYS}" \
    -extfile "${OUT_DIR}/${NAME}.ext" 2>/dev/null

echo "[3/3] Packaging bundles..."

# PEM bundle (key + cert). generate_certs.sh 와 같은 순서로 둔다.
cat "${OUT_DIR}/${NAME}.key" "${OUT_DIR}/${NAME}.crt" > "${OUT_DIR}/${NAME}.pem"

# PKCS#12 — Android KeyStore · iOS Keychain · Electron 이 모두 이것을 받는다.
# -legacy 는 OpenSSL 3 에서 옛 알고리즘으로 싸는 스위치다. 그것이 없으면 구형
# Android 가 못 연다. OpenSSL 1.1 에는 이 플래그가 없어 두 번째 줄로 떨어진다.
openssl pkcs12 -export \
    -in "${OUT_DIR}/${NAME}.crt" \
    -inkey "${OUT_DIR}/${NAME}.key" \
    -certfile "${CA_DIR}/ca.crt" \
    -name "${CN}" \
    -out "${OUT_DIR}/${NAME}.p12" \
    -passout "pass:${P12_PASSWORD}" \
    -legacy 2>/dev/null || \
openssl pkcs12 -export \
    -in "${OUT_DIR}/${NAME}.crt" \
    -inkey "${OUT_DIR}/${NAME}.key" \
    -certfile "${CA_DIR}/ca.crt" \
    -name "${CN}" \
    -out "${OUT_DIR}/${NAME}.p12" \
    -passout "pass:${P12_PASSWORD}" 2>/dev/null

# CA 인증서를 같이 담는다.
#   ca.crt (PEM)  웹 · Android network_security_config
#   ca.cer (DER)  iOS 구성 프로파일이 이 형식을 요구한다
cp "${CA_DIR}/ca.crt" "${OUT_DIR}/ca.crt"
openssl x509 -in "${CA_DIR}/ca.crt" -outform der -out "${OUT_DIR}/ca.cer" 2>/dev/null

rm -f "${OUT_DIR}/${NAME}.csr" "${OUT_DIR}/${NAME}.ext"

echo ""
echo "=== Done ==="
echo ""
echo "${OUT_DIR}/"
echo "├── ${NAME}.key      개인키 — 이 단말 밖으로 내보내지 않는다"
echo "├── ${NAME}.crt      인증서"
echo "├── ${NAME}.pem      PEM bundle (key + cert)"
echo "├── ${NAME}.p12      PKCS#12 — Android · iOS · Electron"
echo "├── ca.crt           CA (PEM)"
echo "└── ca.cer           CA (DER) — iOS 프로파일용"
echo ""
if [[ -z "$P12_PASSWORD" ]]; then
    echo ".p12 비밀번호: (빈 값)"
    echo "  일부 단말은 빈 비밀번호의 .p12 를 거부합니다. 그럴 때는"
    echo "  --p12-password 로 다시 발급하세요."
else
    echo ".p12 비밀번호: ${P12_PASSWORD}"
fi
echo ""
echo "서버 쪽은 손댈 것이 없습니다 — nginx 의 client_ca 가 이 CA 를 이미"
echo "가리키고 있으므로, 이 인증서는 그대로 검증됩니다."
echo ""
echo "확인:"
echo "  openssl verify -CAfile ${CA_DIR}/ca.crt ${OUT_DIR}/${NAME}.crt"
echo "  curl --cert ${OUT_DIR}/${NAME}.crt --key ${OUT_DIR}/${NAME}.key https://<host>/"
