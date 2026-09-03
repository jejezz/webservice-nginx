/**
 * @file deviceCert.ts
 * @brief 단말의 CSR 에 서명해 클라이언트 인증서(mTLS)를 발급한다.
 *
 * ── 흐름 ─────────────────────────────────────────────────────────
 *   ① 앱이 단말 안에서 키쌍을 만든다 (개인키는 Keystore 밖으로 안 나온다)
 *   ② 등록할 때 CSR 을 함께 보낸다        -> mobile_enrollments.csr
 *   ③ 월패드가 승인한다                   -> "그 집 것" 이 확정되는 순간
 *   ④ 앱이 다시 등록하면 인증서를 받아 간다
 *
 * 개인키는 네트워크를 타지 않는다. 올라가는 것은 CSR(공개), 내려가는 것은
 * 인증서(공개)뿐이다.
 *
 * ── ⚠️ CSR 의 주체(subject)를 절대 쓰지 않는다 ────────────────────
 * CSR 은 **누구나 원하는 내용으로** 만들 수 있다. 거기 적힌 CN 을 그대로
 * 인증서에 옮기면, 남의 uuid 나 다른 단지 ID 를 적어 보내는 것만으로 그 신원을
 * 받아 간다. CSR 에서 가져오는 것은 **공개키 하나뿐**이고, 주체는 서버가
 * 아는 값(승인된 등록의 uuid·complexId)으로 새로 쓴다.
 *
 * ── ⚠️ 이 CA 키는 지금 이 서버에 있다 ────────────────────────────
 * 단지가 하나인 동안의 **임시 예외**다. 클라이언트 CA 는 전 단지 공통이므로,
 * 이 키가 새면 **모든 단지에서 통하는 인증서**를 찍어낼 수 있다.
 *
 *   → 두 번째 단지가 생기기 전에 중앙 발급으로 옮겨야 한다.
 *     그때 이 파일은 "서명한다" 에서 "발급 서비스에 물어본다" 로 바뀐다.
 *
 * 설계 배경은 docs/multi-complex.md 를 보라.
 */

import fs from 'fs';
import path from 'path';
import forge from 'node-forge';
import logger from './logger';

/**
 * 유효기간 90일.
 *
 * CRL 을 운영하지 않기 위한 선택이다. 잃어버린 단말은 `active = 0` 으로 즉시
 * 막고(DB 조회에서 빠진다), 인증서는 스스로 죽게 둔다. 인증서만으로 인가를
 * 판단하지 않으므로 성립한다.
 */
const VALID_DAYS = 90;

/** CA 파일 위치. nginx 가 `ssl_client_certificate` 로 보는 그 CA 와 같아야 한다. */
const CA_DIR = process.env.CLIENT_CA_DIR
    || path.resolve(__dirname, '../../../../nginx/cert/ca');

export interface IssuedCert {
    /** 인증서 PEM. 앱에 그대로 내려준다. */
    pem: string;
    /** 일련번호(16진수). 폐기·추적에 쓴다. */
    serial: string;
    expiresAt: Date;
}

let cached: { cert: forge.pki.Certificate; key: forge.pki.PrivateKey } | null = null;

/**
 * CA 를 읽어 둔다. 없으면 null — 발급을 못 할 뿐 서버는 정상 동작해야 한다.
 * mTLS 는 선택적 기능이고, CA 가 없다고 통화가 막히면 안 된다.
 */
function loadCa(): { cert: forge.pki.Certificate; key: forge.pki.PrivateKey } | null {
    if (cached) return cached;

    const certPath = path.join(CA_DIR, 'ca.crt');
    const keyPath = path.join(CA_DIR, 'ca.key');
    try {
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
        cached = {
            cert: forge.pki.certificateFromPem(fs.readFileSync(certPath, 'utf8')),
            key: forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8')),
        };
        return cached;
    } catch (err: any) {
        // 키를 못 읽는 것은 설정 문제다. 조용히 넘어가면 나중에 "왜 발급이
        // 안 되지" 로 한참 헤맨다.
        logger.error(`클라이언트 CA 를 읽지 못했습니다 (${CA_DIR}): ${err.message}`);
        return null;
    }
}

/** 발급이 가능한 배치인가. 기동 로그와 /health 에 쓴다. */
export function isConfigured(): boolean {
    return loadCa() !== null;
}

/**
 * 일련번호. 같은 CA 안에서 겹치면 안 된다.
 *
 * 시각만 쓰면 같은 밀리초에 둘이 들어올 때 겹친다. 난수를 붙인다.
 * 최상위 비트가 서면 음수로 읽히는 구현이 있어 앞자리를 0 으로 둔다.
 */
function newSerial(): string {
    const rand = forge.random.getBytesSync(12);
    return '0' + forge.util.bytesToHex(rand);
}

/**
 * CSR 에 서명한다.
 *
 * @param csrPem  단말이 보낸 CSR. **주체는 무시하고 공개키만 가져간다.**
 * @param subject 서버가 아는 신원. 승인된 등록에서 온 값이어야 한다.
 * @returns 발급 실패면 null (사유는 로그에)
 */
export function sign(
    csrPem: string,
    subject: { uuid: string; complexId: string | null },
): IssuedCert | null {
    const ca = loadCa();
    if (!ca) return null;

    let csr: forge.pki.CertificateSigningRequest;
    try {
        csr = forge.pki.certificationRequestFromPem(csrPem);
    } catch {
        logger.warn(`CSR 을 읽지 못했습니다 (uuid=${subject.uuid})`);
        return null;
    }

    // 서명 검증. 이걸 안 하면 남의 공개키를 담은 CSR 을 그대로 받아 준다 —
    // 개인키를 갖지 않은 자에게 그 공개키의 인증서를 내주는 셈이다.
    if (!csr.verify()) {
        logger.warn(`CSR 자체 서명이 맞지 않습니다 (uuid=${subject.uuid})`);
        return null;
    }
    if (!csr.publicKey) {
        logger.warn(`CSR 에 공개키가 없습니다 (uuid=${subject.uuid})`);
        return null;
    }

    const cert = forge.pki.createCertificate();
    cert.publicKey = csr.publicKey;          // ← CSR 에서 가져오는 것은 이것뿐이다
    cert.serialNumber = newSerial();

    const now = new Date();
    // 시계가 조금 어긋난 단말에서 "아직 유효하지 않음" 이 나지 않도록 5분 당긴다.
    cert.validity.notBefore = new Date(now.getTime() - 5 * 60 * 1000);
    cert.validity.notAfter = new Date(now.getTime() + VALID_DAYS * 86400 * 1000);

    // 주체는 서버가 쓴다. CSR 에 뭐가 적혀 있든 보지 않는다.
    cert.setSubject([
        { name: 'commonName', value: subject.uuid },
        ...(subject.complexId
            ? [{ name: 'organizationalUnitName', value: subject.complexId }]
            : []),
    ]);
    cert.setIssuer(ca.cert.subject.attributes);

    cert.setExtensions([
        // 단말 인증서다. 다른 인증서에 서명할 수 없어야 한다.
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        // 클라이언트 인증 전용. 이게 없으면 서버 인증서로도 쓸 수 있다.
        { name: 'extKeyUsage', clientAuth: true },
    ]);

    cert.sign(ca.key as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

    return {
        pem: forge.pki.certificateToPem(cert),
        serial: cert.serialNumber,
        expiresAt: cert.validity.notAfter,
    };
}
