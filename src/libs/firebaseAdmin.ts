/**
 * @file firebaseAdmin.ts
 * @brief FCM 발송용 Firebase Admin SDK 초기화.
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
 * 키 위치는 .env 의 FIREBASE_SERVICE_ACCOUNT_PATH 가 정한다 (서비스 디렉토리 기준
 * 상대 경로 또는 절대 경로). 기본값은 secrets/firebase-admin.json 이다.
 */
import firebase from 'firebase-admin';
import { Messaging } from 'firebase-admin/messaging';
import * as fs from 'fs';
import * as path from 'path';
import logger from './logger';

/** 서비스 디렉토리 (src 의 상위). 상대 경로의 기준점이다. */
const SERVICE_DIR = path.resolve(__dirname, '..', '..');
const KEY_FILE = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'secrets/firebase-admin.json';

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

let accountParams: any = null;
let loadError: string | null = null;

(function loadServiceAccount() {
    const file = path.isAbsolute(KEY_FILE) ? KEY_FILE : path.resolve(SERVICE_DIR, KEY_FILE);
    try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!json.private_key || !json.client_email) throw new Error('private_key 또는 client_email 이 없습니다');
        accountParams = toCredential(json);
        logger.info(`Firebase service account loaded: ${json.client_email}`);
    } catch (err: any) {
        loadError = `${file}: ${err.message}`;
        logger.warn(`Firebase 서비스 계정 키를 읽을 수 없습니다 (${loadError}) — 착신 푸시(FCM)가 비활성화됩니다.`);
    }
})();

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

    /** @brief 상태. /health 와 대시보드가 쓴다. */
    public static status(): { configured: boolean; clientEmail?: string; error?: string } {
        if (!accountParams) return { configured: false, error: loadError ?? 'not configured' };
        return { configured: true, clientEmail: accountParams.clientEmail };
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
}
