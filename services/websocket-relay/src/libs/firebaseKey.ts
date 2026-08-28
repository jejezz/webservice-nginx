/**
 * @file firebaseKey.ts
 * @brief FCM 서비스 계정 키를 **살펴보고 갈아 끼운다.**
 *
 * ── 왜 살펴보는 단계가 따로 있는가 ───────────────────────────────
 * 이 키를 잘못 올리면 **조용히** 망가진다. 서비스는 정상으로 뜨고, 대시보드도
 * 초록색이고, 방도 잘 열린다. 다른 것은 딱 하나 — 초인종을 눌러도 자고 있는
 * 집의 전화가 울리지 않는다. 그 사실은 주민이 민원을 넣어야 알게 된다.
 *
 * 그래서 파일을 쓰기 **전에** 판단할 수 있는 것은 전부 판단한다.
 *
 *   ① 이게 서버용 키가 맞나        웹 SDK 설정(apiKey…)을 올리는 실수가 가장 흔하다
 *   ② 형식이 온전한가              private_key 가 PEM 인지까지 본다
 *   ③ **프로젝트가 바뀌는가**      이게 제일 위험하다 (아래)
 *   ④ 실제로 통하는가              Google 에 토큰을 한 번 받아 본다
 *
 * ── ③ 이 왜 제일 위험한가 ───────────────────────────────────────
 * FCM 등록 토큰은 **Firebase 프로젝트에 묶여 있다.** 다른 프로젝트의 키로
 * 바꾸면 DB 에 저장된 토큰이 전부 남의 프로젝트 것이 되어, 발송은 성공한 것처럼
 * 보이지만 아무 데도 닿지 않는다. 단말이 앱을 다시 열어 /register 로 새 토큰을
 * 보내기 전까지는 복구되지 않는다.
 *
 * 되돌릴 수 있게 **덮어쓰기 전에 always 백업**한다.
 */
import fs from 'fs';
import path from 'path';
import config from '../config';
import logger from './logger';
import { Firebase, KeyIdentity } from './firebaseAdmin';

export type Severity = 'error' | 'warn' | 'ok';

export interface Finding {
    severity: Severity;
    message: string;
    /** 사람이 뭘 해야 하는지. 없으면 설명만. */
    hint?: string;
}

export interface Analysis {
    /** 쓸 수 있는 키인가. error 가 하나라도 있으면 false. */
    usable: boolean;
    identity: KeyIdentity | null;
    findings: Finding[];
    /** 지금 쓰고 있는 키와 프로젝트가 다른가. 화면이 이걸로 경고를 띄운다. */
    projectChanges: boolean;
    /** 지금 쓰는 것과 같은 키인가 (private_key_id 가 같다). */
    sameKey: boolean;
}

/** 서비스 계정 키에 반드시 있어야 하는 것들. */
const REQUIRED = ['type', 'project_id', 'private_key', 'client_email'] as const;

/** 웹/모바일 SDK 설정에만 있는 것들. 하나라도 있으면 잘못 올린 것이다. */
const CLIENT_CONFIG_KEYS = ['apiKey', 'appId', 'authDomain', 'messagingSenderId', 'storageBucket'];

/**
 * 올리려는 내용을 살펴본다. **파일을 건드리지 않는다.**
 *
 * @param raw 업로드된 JSON 문자열
 */
export function analyze(raw: string): Analysis {
    const findings: Finding[] = [];
    const fail = (message: string, hint?: string): Analysis => {
        findings.push({ severity: 'error', message, hint });
        return { usable: false, identity: null, findings, projectChanges: false, sameKey: false };
    };

    let json: any;
    try {
        json = JSON.parse(raw);
    } catch (err: any) {
        return fail(`JSON 으로 읽을 수 없습니다: ${err.message}`,
            'Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성" 으로 받은 파일을 그대로 올리세요.');
    }

    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return fail('JSON 객체가 아닙니다.');
    }

    // ① 웹 SDK 설정을 올린 경우. 제일 흔한 실수라 가장 먼저, 가장 분명하게 말한다.
    const clientKeys = CLIENT_CONFIG_KEYS.filter((k) => k in json);
    if (clientKeys.length > 0 && !json.private_key) {
        return fail(
            `웹/앱용 Firebase 설정입니다 (${clientKeys.join(', ')}). 서버용 키가 아닙니다.`,
            'Firebase 콘솔 → 프로젝트 설정 → **서비스 계정** 탭에서 "새 비공개 키 생성" 을 누르세요. ' +
            '일반 설정 탭의 SDK 스니펫이 아닙니다.');
    }

    const missing = REQUIRED.filter((k) => !json[k]);
    if (missing.length > 0) {
        return fail(`빠진 항목이 있습니다: ${missing.join(', ')}`);
    }

    if (json.type !== 'service_account') {
        return fail(`type 이 "${json.type}" 입니다 — "service_account" 여야 합니다.`);
    }

    // ② 개인키가 정말 PEM 인가. 복사하다 줄바꿈이 깨진 파일이 종종 올라온다.
    const pem = String(json.private_key);
    if (!pem.includes('BEGIN PRIVATE KEY') || !pem.includes('END PRIVATE KEY')) {
        return fail('private_key 가 PEM 형식이 아닙니다.',
            '파일을 편집기로 열어 고치지 말고, 받은 파일을 그대로 올리세요. 줄바꿈(\\n)이 깨지면 서명이 실패합니다.');
    }

    const identity: KeyIdentity = {
        projectId: String(json.project_id),
        clientEmail: String(json.client_email),
        privateKeyId: String(json.private_key_id ?? ''),
        clientId: json.client_id ? String(json.client_id) : undefined,
    };

    // 서비스 계정 이메일은 보통 <이름>@<project_id>.iam.gserviceaccount.com 이다.
    // 어긋나도 동작은 하므로(다른 프로젝트의 계정에 권한을 준 경우) 경고까지만 한다.
    if (!identity.clientEmail.endsWith(`@${identity.projectId}.iam.gserviceaccount.com`)) {
        findings.push({
            severity: 'warn',
            message: `서비스 계정(${identity.clientEmail})이 프로젝트(${identity.projectId})에 속한 것으로 보이지 않습니다.`,
            hint: '다른 프로젝트의 계정에 권한을 준 경우라면 정상입니다. 아니라면 파일을 다시 확인하세요.',
        });
    }

    const current = Firebase.getIdentity();
    const sameKey = Boolean(current && identity.privateKeyId && current.privateKeyId === identity.privateKeyId);
    const projectChanges = Boolean(current && current.projectId !== identity.projectId);

    if (sameKey) {
        findings.push({ severity: 'ok', message: '지금 쓰고 있는 키와 같습니다. 올려도 달라지는 것이 없습니다.' });
    } else if (projectChanges) {
        // 이 한 줄이 이 파일이 존재하는 이유다.
        findings.push({
            severity: 'warn',
            message: `Firebase 프로젝트가 ${current!.projectId} → ${identity.projectId} 로 **바뀝니다.**`,
            hint: 'FCM 등록 토큰은 프로젝트에 묶여 있어, 지금 등록된 단말의 토큰이 모두 무효가 됩니다. ' +
                  '각 단말이 앱을 열어 다시 등록하기 전까지 착신 푸시가 가지 않습니다.',
        });
    } else if (current) {
        findings.push({
            severity: 'ok',
            message: `같은 프로젝트(${identity.projectId})의 다른 키입니다. 등록된 토큰은 그대로 쓸 수 있습니다.`,
        });
    } else {
        findings.push({
            severity: 'ok',
            message: `푸시가 꺼져 있던 상태에서 켜집니다 (프로젝트 ${identity.projectId}).`,
        });
    }

    return { usable: true, identity, findings, projectChanges, sameKey };
}

/** 지금 설치된 키 파일의 상태. 내용은 읽되 비밀은 밖으로 내보내지 않는다. */
export function installedStatus(): {
    path: string;
    exists: boolean;
    /** 8진수 세 자리. 600 이 아니면 화면이 경고한다. */
    mode?: string;
    modifiedAt?: string;
    sizeBytes?: number;
    identity: KeyIdentity | null;
    error?: string;
} {
    const file = config.firebase.serviceAccountPath;
    const identity = Firebase.getIdentity();

    try {
        const st = fs.statSync(file);
        return {
            path: file,
            exists: true,
            mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
            modifiedAt: st.mtime.toISOString(),
            sizeBytes: st.size,
            identity,
        };
    } catch {
        return { path: file, exists: false, identity, error: Firebase.status().error };
    }
}

/**
 * 키를 설치한다. 덮어쓰기 전에 **반드시 백업**한다.
 *
 * @returns 새 키가 실제로 통하는지까지 확인한 결과
 */
export async function install(raw: string): Promise<
    | { ok: true; identity: KeyIdentity; backup: string | null; live: { ok: boolean; error?: string } }
    | { ok: false; analysis: Analysis }
> {
    const analysis = analyze(raw);
    if (!analysis.usable || !analysis.identity) {
        return { ok: false, analysis };
    }

    const file = config.firebase.serviceAccountPath;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // 되돌릴 수 있게 남긴다. 프로젝트를 잘못 바꾼 것을 며칠 뒤에 알아차리는
    // 일이 있어서, 지우지 않고 쌓아 둔다 (파일 하나가 2KB 남짓이다).
    let backup: string | null = null;
    if (fs.existsSync(file)) {
        backup = path.join(dir, `firebase-admin.${new Date().toISOString().replace(/[:.]/g, '-')}.bak.json`);
        fs.copyFileSync(file, backup);
        fs.chmodSync(backup, 0o600);
    }

    // 먼저 0600 으로 만들고 쓴다. 순서가 반대면 아주 잠깐 다른 사용자가 읽을 수 있다.
    const fd = fs.openSync(file, 'w', 0o600);
    try {
        fs.writeSync(fd, raw);
    } finally {
        fs.closeSync(fd);
    }
    fs.chmodSync(file, 0o600);

    await Firebase.reload();
    const live = await Firebase.verifyLive();

    logger.info(
        `[dashboard] FCM 키 교체: project=${analysis.identity.projectId} ` +
        `account=${analysis.identity.clientEmail} 검증=${live.ok ? '성공' : `실패(${live.error})`}` +
        (backup ? ` 백업=${path.basename(backup)}` : ''),
    );

    return { ok: true, identity: analysis.identity, backup: backup && path.basename(backup), live };
}

/**
 * 키를 내린다. 푸시만 꺼지고 중계는 계속 돈다.
 * 지우기 전에 백업하므로 되돌릴 수 있다.
 */
export async function remove(): Promise<{ removed: boolean; backup: string | null }> {
    const file = config.firebase.serviceAccountPath;
    if (!fs.existsSync(file)) {
        await Firebase.reload();
        return { removed: false, backup: null };
    }

    const dir = path.dirname(file);
    const backup = path.join(dir, `firebase-admin.${new Date().toISOString().replace(/[:.]/g, '-')}.bak.json`);
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
    fs.unlinkSync(file);

    await Firebase.reload();
    logger.warn(`[dashboard] FCM 키를 내렸습니다 — 착신 푸시가 비활성입니다. 백업=${path.basename(backup)}`);
    return { removed: true, backup: path.basename(backup) };
}
