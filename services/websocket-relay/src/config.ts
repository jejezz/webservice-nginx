/**
 * @file config.ts
 * @brief 환경 변수를 읽는 **단 한 곳**.
 *
 * ── 왜 한 곳으로 모았는가 ────────────────────────────────────────
 * 통합 전에는 `process.env` 접근이 index.ts · routes/* · libs/* 에 흩어져 있었고
 * 같은 값의 기본값이 파일마다 달랐다 (PORT 는 index 와 dashboardApi 에서 따로,
 * 테이블 이름은 index 의 static 과 config 두 군데에서).
 *
 * 게다가 dotenv 를 언제 부르느냐가 조용한 버그를 만들었다. TypeScript 가
 * CommonJS 로 낼 때 `import` 는 전부 `require()` 가 되어 **파일 본문보다 먼저**
 * 실행된다. 그래서 index.ts 맨 위에서 `dotenv.config()` 를 불러도, index 가
 * import 하는 모듈이 자기 본문에서 `process.env.X` 를 읽으면 그 시점엔 아직
 * `.env` 가 반영되지 않아 늘 undefined 였다. (COMPLEX_ID 를 .env 에 넣었는데
 * 서버가 계속 "미설정" 이라고 한 적이 있다. 이걸 막으려고 두던 `libs/env.ts`
 * 사이드이펙트 import 는 이 파일이 대신한다 — 여기서 한 번 읽고, 나머지
 * 모듈은 이 객체만 본다.)
 *
 * ── 로거를 쓰지 않는다 ───────────────────────────────────────────
 * logger 가 이 파일을 보므로(로그 경로·수준), 여기서 logger 를 부르면 순환이
 * 된다. 그래서 잘못된 값은 던지지도 찍지도 않고 `warnings` 에 모아 두고,
 * index.ts 가 기동 로그에 함께 남긴다.
 */
import path from 'path';
import dotenv from 'dotenv';

// quiet: 부팅할 때마다 pm2 로그에 dotenv 배너가 찍히지 않도록.
dotenv.config({ quiet: true });

/** 서비스 디렉토리 (src 의 상위). 아래 상대 경로들의 기준점이다. */
const ROOT = path.resolve(__dirname, '..');

/** 상대 경로는 서비스 디렉토리 기준으로 푼다 — cwd 가 어디든 같은 파일을 가리키도록. */
function fromRoot(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

function num(value: string | undefined, fallback: number): number {
    const n = value ? parseInt(value, 10) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(value);
}

/** 기동 로그에 남길 설정 경고. index.ts 가 읽어 찍는다. */
const warnings: string[] = [];

const isProduction = process.env.NODE_ENV === 'production';

/** 32비트를 소문자 16진수 8자로. 생성: `openssl rand -hex 4` */
export const COMPLEX_ID_RE = /^[0-9a-f]{8}$/;
export const COMPLEX_ID_ERROR = 'complexId 는 소문자 16진수 8자여야 합니다 (예: a3f19c04).';

/**
 * 이 서버가 맡은 단지. 형식이 틀리면 검사를 켜지 않고 경고만 남긴다 —
 * 잘못된 값으로 검사를 켜면 멀쩡한 단말이 전부 거부되기 때문이다.
 */
function readComplexId(): string | null {
    const raw = (process.env.COMPLEX_ID ?? '').trim().toLowerCase();
    if (raw === '') return null;
    if (!COMPLEX_ID_RE.test(raw)) {
        warnings.push(`COMPLEX_ID 형식이 잘못됐습니다: "${raw}" — ${COMPLEX_ID_ERROR} 단지 검사를 켜지 않고 계속합니다.`);
        return null;
    }
    return raw;
}

export const config = {
    /** 서비스 디렉토리. `require(config.root + '/package.json')` 처럼 쓴다. */
    root: ROOT,
    env: process.env.NODE_ENV || 'development',
    isProduction,

    /**
     * `/health` 의 service, pm2 프로세스 이름, nginx-conf 의 `[service] name` 이
     * 모두 이 값이어야 한다 (docs/health-contract.md).
     */
    serviceName: 'websocket-relay',

    /**
     * 듣는 주소. **기본이 루프백이다.**
     *
     * nginx 가 앞에 서므로 바깥에서 이 포트로 직접 들어올 일이 없다. 루프백에
     * 묶어 두면 `/mobile-crud-operation` 의 사설망 허용 대역이 같은 호스트로
     * 좁혀진다. Kamailio 도 같은 호스트에 있으므로 `/sip-push` 는 그대로 된다.
     *
     * HTTPS_PORT 는 자체 TLS 를 걷어내기 전에 쓰던 이름이라 아직 받아 준다.
     */
    host: process.env.BIND_ADDR || process.env.HOST || '127.0.0.1',
    port: num(process.env.PORT || process.env.HTTPS_PORT, 28099),

    /**
     * nginx 가 이 서비스를 프록시할 때 쓰는 경로 접두사.
     *
     * nginx 는 `proxy_path` 를 두지 않으므로 **원본 URI 가 그대로** 넘어온다.
     * 즉 공개 주소 `/relay/register` 는 여기에도 `/relay/register` 로 도착한다.
     * 그래서 라우터를 루트('/')와 이 접두사 양쪽에 붙인다 (app.ts).
     *
     * ⚠️ 접두사를 nginx 에서 잘라내지 않는 것은 **의도된 것**이다. 잘라내면
     *    `/mobile-crud-operation` · `/sip-push` 처럼 앱에만 붙여 둔 내부 전용
     *    경로가 프록시로 노출되고, 그 요청은 소켓 주소가 늘 127.0.0.1(nginx)이라
     *    내부망 검사를 무조건 통과한다. app.ts 의 두 미들웨어 주석 참고.
     */
    basePath: process.env.BASE_PATH || '/relay',

    /** 관리 대시보드 경로 (basePath 하위). manager 가 이 값으로 링크를 만든다. */
    dashboardPath: process.env.DASHBOARD_PATH || '/dashboard',

    /** 빌드된 대시보드 위치 — web/dist */
    dashboardDir: path.join(ROOT, 'web', 'dist'),

    /**
     * 이 서버가 맡은 단지. null 이면 단지 검사를 **하지 않는다** — 단지가
     * 하나뿐인 배치를 그대로 돌리기 위해서다. 한 번 정하면 바꾸지 않는다.
     * 바꾸면 이미 등록된 단말이 전부 자기 단지를 잃는다.
     */
    complexId: readComplexId(),

    /**
     * MariaDB. 프로젝트의 DB 규약은 database/README.md 에 있다 —
     * 스키마는 서비스가 소유하고(schema/*.sql), 접속 계정은 공용 jyahn 하나이며,
     * 비밀번호는 소스가 아니라 database/secrets/jyahn.pw 에 있다.
     */
    db: {
        host: process.env.DB_HOST || '127.0.0.1',
        port: num(process.env.DB_PORT, 3306),
        user: process.env.DB_USER || 'jyahn',
        /** DB 이름에는 하이픈을 쓸 수 없어 서비스 이름과 다르다. */
        name: process.env.DB_NAME || 'rtc_relay',
        connectionLimit: num(process.env.DB_CONNECTION_LIMIT, 5),
        /** .env 에 직접 적었다면 그것을 쓴다. 없으면 아래 파일에서 읽는다. */
        password: process.env.DB_PASSWORD || null,
        passwordFile: fromRoot(process.env.DB_PASSWORD_FILE || '../../database/secrets/jyahn.pw'),
    },

    /** 표 이름. 예전에는 index.ts 의 static 이었고, 그 때문에 libs/* 와 routes/* 가
     *  이름 하나 얻으려고 index 를 다시 import 해 순환 참조가 생겼다. */
    tables: {
        mobile: process.env.MOBILE_TABLE_NAME || 'rtc_mobiles',
        homenet: process.env.HOMENET_TABLE_NAME || 'rtc_homenet',
    },

    /**
     * FCM 푸시. 키가 없으면 푸시만 꺼지고 릴레이는 계속 돈다 — 앱이 떠 있는
     * 단말끼리는 푸시 없이도 통화가 되기 때문이다.
     */
    firebase: {
        serviceAccountPath: fromRoot(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'secrets/firebase-admin.json'),
        /** 앱이 만들어 둔 알림 채널. 소리와 중요도가 여기에 묶여 있다. */
        channelId: process.env.FCM_CHANNEL_ID || 'callfusion_2_rtc',
        sound: process.env.FCM_SOUND_FILE || 'doorbell.wav',
    },

    ws: {
        /** 죽은 연결을 걷어내는 ping 주기. */
        pingIntervalMs: num(process.env.WS_PING_INTERVAL, 60000),
        /** 방이 비었을 때 등록을 유지하는 시간. */
        registerTimeoutMs: num(process.env.WS_REGISTER_TIMEOUT, 1000),
        /** IoT 상태 조회를 미루는 시간. 0 이면 즉시 보낸다. */
        iotStatusDelayMs: num(process.env.IOT_STATUS_DELAY_MS, 0),
    },

    /**
     * manager 로그인 세션. 서비스마다 계정을 두지 않고 manager 시크릿으로
     * HMAC 만 검증한다 (auth/session.ts).
     */
    session: {
        secretFile: fromRoot(process.env.SESSION_SECRET_FILE || '../.session-secret'),
    },

    /**
     * manager 의 내부 주소.
     *
     * 되돌리기 어려운 설정을 바꿀 때 **비밀번호를 다시 확인**하는 데 쓴다.
     * 확인은 브라우저가 아니라 이 서버가 한다 — 브라우저가 "확인했다" 고 말하는
     * 것은 신뢰할 수 없다 (세션만 있으면 우리 API 를 직접 불러 건너뛴다).
     *
     * manager 는 같은 호스트의 루프백에 있다. nginx 를 거치지 않는다.
     */
    manager: {
        verifyPasswordUrl:
            process.env.MANAGER_VERIFY_URL || 'http://127.0.0.1:28084/manager/api/verify-password',
    },

    /**
     * 앱이 붙어야 할 Janus 주소. 공개 주소라 서버가 스스로 알 수 없어 설정으로
     * 받는다. 비어 있으면 착신 푸시 payload 에 싣지 않는다.
     */
    janus: {
        wsUrl: (process.env.JANUS_WS_URL ?? '').trim(),
    },

    /**
     * SIP 계정 발급. 승인된 단말에게 Kamailio 내선을 만들어 준다
     * (docs/identity.md).
     *
     * 같은 MariaDB 인스턴스의 **다른 스키마**를 쓴다. 접속 계정(jyahn)이 두
     * 스키마 모두에 권한을 갖고 있으므로 풀을 하나 더 만들지 않고 표 이름에
     * 스키마를 붙여 쓴다 — 풀이 둘이면 비밀번호·재접속·상태 보고가 두 벌이 된다.
     *
     * `provision` 을 끄면 번호는 배정하되 계정은 만들지 않는다. Kamailio 가
     * 없는 배치(개발기)에서 승인이 막히지 않게 하기 위한 것이다.
     */
    sip: {
        provision: bool(process.env.SIP_PROVISION, true),
        /** kamctlrc 의 SIP_DOMAIN 과 같아야 한다. 다르면 만든 계정으로 등록되지 않는다. */
        domain: (process.env.SIP_DOMAIN || 'pluto.org').trim(),
        subscriberTable: process.env.SIP_SUBSCRIBER_TABLE || 'kamailio.subscriber',
    },

    log: {
        level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
        dir: fromRoot(process.env.LOG_DIR || 'logs'),
        /**
         * 프로덕션에서는 pm2 가 stdout 을 파일로 받으므로 기본으로 끈다.
         * 파일 트랜스포트와 겹쳐 같은 내용을 두 번 쓰기 때문이다.
         */
        console: bool(process.env.CONSOLE_LOGGING, !isProduction),
    },

    /** 기동할 때 index.ts 가 찍는다. */
    warnings,
} as const;

export default config;
