/**
 * @file firebaseAdmin.ts
 * @brief FCM 발송용 Firebase Admin SDK. **다시 읽을 수 있다.**
 *
 * 서비스 계정 키는 **소스에 두지 않는다.** 이 프로젝트의 시크릿 규약과 같다 —
 * database/secrets/*.pw, services/.session-secret 처럼 파일로 두고 권한을 600 으로
 * 좁히며 git 에 올리지 않는다.
 *
 * 이관 전에는 src/config/firebase-admin.json 을 정적 import 로 끌어와 커밋까지 돼
 * 있었다. 그러면 키가 소스 트리에 못박혀 저장소를 복제하는 모두에게 따라간다.
 *
 * 키를 못 읽으면 FCM 만 비활성으로 두고 시그널링은 그대로 돈다. 착신 푸시가 없으면
 * 앱이 떠 있는 단말끼리는 여전히 통화가 되기 때문이다.
 *
 * ── 왜 reload 가 있는가 ──────────────────────────────────────────
 * 예전에는 이 파일이 모듈을 읽는 순간 딱 한 번 키를 읽었다. 그래서 키를 바꾸려면
 * **서비스를 재시작해야 했고**, 재시작은 프로세스 메모리에 있는 방을 전부
 * 날린다 — 통화 중인 사람이 끊긴다. 대시보드에서 키를 올릴 수 있게 되면서
 * 그 대가를 치를 이유가 없어졌다. `reload()` 는 기존 app 을 지우고 다시 만든다.
 */
import firebase from 'firebase-admin';
import { Messaging } from 'firebase-admin/messaging';
import * as fs from 'fs';
import config from '../config';
import logger from './logger';

/** firebase-admin 이 요구하는 형태로 옮겨 담는다. */
function toCredential(json: any) {
    return {
        type: json.type,
        projectId: json.project_id,
        privateKeyId: json.private_key_id,
        privateKey: json.private_key,
        clientEmail: json.client_email,
        clientId: json.client_id,
        authUri: json.auth_uri,
        tokenUri: json.token_uri,
        authProviderX509CertUrl: json.auth_provider_x509_cert_url,
        clientC509CertUrl: json.client_x509_cert_url,
    };
}

/** 키에서 **비밀이 아닌 부분만** 뽑아 둔다. 화면과 /health 가 이것만 본다. */
export interface KeyIdentity {
    projectId: string;
    clientEmail: string;
    /** 어느 키인지 구분하는 값. 개인키 자체가 아니라 그 식별자다. */
    privateKeyId: string;
    clientId?: string;
}

let accountParams: any = null;
let identity: KeyIdentity | null = null;
let loadError: string | null = null;

/**
 * 파일을 읽어 자격 증명을 세운다.
 *
 * 실패해도 던지지 않는다 — 푸시만 꺼지고 중계는 계속 돌아야 한다.
 * @returns 읽었으면 true
 */
function loadServiceAccount(): boolean {
    const file = config.firebase.serviceAccountPath;
    try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!json.private_key || !json.client_email) {
            throw new Error('private_key 또는 client_email 이 없습니다');
        }
        accountParams = toCredential(json);
        identity = {
            projectId: json.project_id,
            clientEmail: json.client_email,
            privateKeyId: json.private_key_id,
            clientId: json.client_id,
        };
        loadError = null;
        logger.info(`Firebase service account loaded: ${json.client_email} (project=${json.project_id})`);
        return true;
    } catch (err: any) {
        accountParams = null;
        identity = null;
        loadError = `${file}: ${err.message}`;
        logger.warn(`Firebase 서비스 계정 키를 읽을 수 없습니다 (${loadError}) — 착신 푸시(FCM)가 비활성화됩니다.`);
        return false;
    }
}

loadServiceAccount();

export class Firebase {
    private static instance: Firebase | null = null;
    private app: firebase.app.App;

    private constructor() {
        this.app = firebase.initializeApp({
            credential: firebase.credential.cert(accountParams),
        });
    }

    public getApp(): firebase.app.App {
        return this.app;
    }

    /** 키를 읽었는지. 호출부가 푸시를 건너뛸지 판단한다. */
    public static isConfigured(): boolean {
        return accountParams !== null;
    }

    /** 지금 쓰고 있는 키의 신원. 비밀은 들어 있지 않다. */
    public static getIdentity(): KeyIdentity | null {
        return identity;
    }

    /** @brief 상태. /health 와 대시보드가 쓴다. */
    public static status(): { configured: boolean; clientEmail?: string; projectId?: string; error?: string } {
        if (!identity) return { configured: false, error: loadError ?? 'not configured' };
        return { configured: true, clientEmail: identity.clientEmail, projectId: identity.projectId };
    }

    public static getInstance(): Firebase | null {
        if (!accountParams) return null;
        if (!Firebase.instance) {
            Firebase.instance = new Firebase();
        }
        return Firebase.instance;
    }

    /** 키가 없으면 null 을 돌려준다. 호출부에서 반드시 확인할 것. */
    public static getMessaging(): Messaging | null {
        return Firebase.getInstance()?.getApp().messaging() ?? null;
    }

    /**
     * 파일을 다시 읽고 SDK 를 새로 세운다. **재시작 없이 키를 바꾸는 길이다.**
     *
     * firebase-admin 은 같은 이름의 app 을 두 번 만들 수 없으므로 기존 것을
     * 먼저 지운다. delete() 는 진행 중인 요청을 기다리는 비동기라 await 한다.
     */
    public static async reload(): Promise<boolean> {
        if (Firebase.instance) {
            try {
                await Firebase.instance.app.delete();
            } catch (err: any) {
                // 지우지 못해도 계속 간다 — 아래에서 새로 만들지 못하면 그때 꺼진다.
                logger.warn(`이전 Firebase app 을 정리하지 못했습니다: ${err.message}`);
            }
            Firebase.instance = null;
        }

        const ok = loadServiceAccount();
        // 여기서 한 번 만들어 둔다. 실패하면 지금 로그에 남고, 나중에 초인종이
        // 울릴 때 처음 알게 되는 일을 피한다.
        if (ok) Firebase.getInstance();
        return ok;
    }

    /**
     * 키가 **실제로 통하는지** Google 에 물어본다.
     *
     * 파일 모양이 맞는 것과 그 키로 토큰을 받을 수 있는 것은 다른 문제다 —
     * 서비스 계정이 지워졌거나, 키가 회수됐거나, 서버 시계가 틀어졌거나(JWT 서명이
     * 거부된다), 바깥으로 나가는 길이 막혀 있을 수 있다. 셋 다 파일만 봐서는
     * 알 수 없고, 초인종이 울릴 때까지 조용하다.
     */
    public static async verifyLive(): Promise<{ ok: boolean; error?: string }> {
        if (!accountParams) return { ok: false, error: loadError ?? 'not configured' };
        try {
            const credential = firebase.credential.cert(accountParams);
            const token = await credential.getAccessToken();
            return { ok: Boolean(token?.access_token) };
        } catch (err: any) {
            return { ok: false, error: err?.message ?? String(err) };
        }
    }
}
