/**
 * @file index.ts
 * @brief websocket-relay 부팅.
 *
 * WebRTC 시그널링과 IoT 기기 메시지를 중계하는 WebSocket 릴레이다. 인터폰이
 * 방문자 호출을 보내면 같은 방(room)의 모바일 단말로 시그널을 넘기고, 단말이
 * 접속해 있지 않으면 FCM 푸시로 깨운다. Kamailio 의 SIP 착신도 /sip-push 로
 * 받아 같은 방식으로 깨운다.
 *
 * ── 이 파일이 하는 일은 순서를 잡는 것뿐이다 ─────────────────────
 *   설정 읽기(config) → DB 확인 → HTTP 서버 → WebSocket → 종료 처리
 *
 * 라우트 조립은 app.ts, 값 읽기는 config.ts, 실행 상태는 gateway.ts 에 있다.
 * 통합 전에는 이 세 가지가 전부 여기 있는 `CallFusion` 싱글턴 안에 섞여 있었고,
 * 다른 모듈이 표 이름 하나를 얻으려고 이 파일을 import 하면서 순환 참조가 생겼다.
 *
 * ── TLS 는 여기서 다루지 않는다 ──────────────────────────────────
 * 예전에는 0.0.0.0:28099 에 직접 HTTPS 를 열고 단말이 포트로 붙었다. 지금은
 * nginx 가 443 에서 TLS 를 끊고 루프백으로 평문을 넘긴다 — 나머지 서비스와
 * 같은 방식이다. 단말이 보는 **인증서는 달라지지 않는다.** nginx 가 내미는
 * 것이 이 서비스가 직접 읽던 바로 그 파일이다. 달라지는 것은 주소와, TLS 를
 * 끊는 곳이 한 군데로 모인다는 점이다.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import config from './config';
import logger from './libs/logger';
import { createApp, hasDashboardBuild } from './app';
import { RelayGateway, setGateway } from './gateway';
import * as janusToken from './libs/janusToken';
import { RtcRoomTable } from './libs/rtcRoomTable';
import { startWebsocketService } from './libs/websocketService';
import { DbConn } from './libs/dbConnection';
import { Firebase } from './libs/firebaseAdmin';
import { backfillComplexId, complexId } from './libs/complex';
import { startPruneTimer } from './libs/enrollment';

process.title = config.serviceName;

/**
 * @brief 최후의 안전망. 잡히지 않은 오류를 기록하되 프로세스는 **살려 둔다.**
 *
 * @details
 * 이전에는 두 처리기가 모두 process.exit(1) 이었다. 그런데 이 서비스에서
 * 예외가 나는 자리는 대부분 **특정 연결 하나**를 처리하는 도중이다.
 *
 *   - 정원(6명)이 찬 방에 invite → RtcRoom.createCallClient 가 throw
 *   - 메시지 큐 1024개 초과 → RtcClient.enqueue 가 throw
 *   - 규약에 없는 입력 → 각 핸들러의 throw
 *
 * ws 의 'message' 리스너는 동기라 이 throw 가 그대로 여기까지 올라왔고,
 * 결과적으로 **클라이언트 한 대의 잘못된 요청이 접속자 전원을 끊었다.**
 * 상태가 전부 프로세스 메모리에 있으니 재시작하면 모든 방이 사라진다.
 * 접속자가 늘수록 이 일이 일어날 확률은 선형으로 올라간다.
 *
 * 그래서 이제 각 WebSocket 메시지 핸들러가 자기 예외를 직접 잡아 해당 연결만
 * 끊는다 (websocketService.ts 의 safeHandle). 여기까지 오는 것은 그 경계를
 * 빠져나온 예기치 못한 오류뿐이므로, 기록만 하고 계속 돈다.
 *
 * @note uncaughtException 이후의 프로세스 상태는 원칙적으로 신뢰할 수 없다.
 * 그럼에도 살려 두는 쪽을 택한 이유는, 여기 도달하는 오류가 대개 한 연결에
 * 국한된 것이고 죽을 때의 피해(전원 절단)가 훨씬 크기 때문이다. 메모리나
 * 상태가 실제로 망가진 경우를 대비해 pm2 의 재시작에 여전히 기대고 있다.
 */
process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION (프로세스는 계속 실행):', err);
});

process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED REJECTION (프로세스는 계속 실행):', reason);
});

/** 기동할 때 지금 설정이 무엇인지 한눈에 남긴다. 대부분의 오배포가 여기서 드러난다. */
function logConfiguration(): void {
    for (const warning of config.warnings) {
        logger.error(warning);
    }

    logger.info('설정:');
    logger.info(`- 듣기: http://${config.host}:${config.port} (TLS 는 nginx 가 끊는다)`);
    logger.info(`- 공개 경로: ${config.basePath}  ·  대시보드: ${config.basePath}${config.dashboardPath}${hasDashboardBuild() ? '' : ' (빌드 없음)'}`);
    logger.info(`- 단지: ${complexId() ?? '미설정 — 단지 검사를 하지 않습니다'}`);
    logger.info(`- 실행 환경: ${config.env}`);
    logger.info(`- DB: ${DbConn.isConfigured() ? `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.name}` : '미설정 — 단말 등록 비활성'}`);
    logger.info(`- 표: ${config.tables.mobile}, ${config.tables.homenet}`);
    logger.info(`- 푸시(FCM): ${Firebase.isConfigured() ? '준비됨' : '미설정 — 착신 푸시 비활성'}`);
}

/**
 * @brief 관리용 비밀 방을 만든다.
 *
 * 방 번호는 파일에 저장해 재시작해도 같은 번호를 쓴다. 없으면
 * 암호학적 난수로 9자리를 새로 만들고 소유자만 읽을 수 있게(0600) 저장한다.
 */
function createSecretRoom(roomTable: RtcRoomTable): void {
    const secretRoomFile = path.join(__dirname, '.secret-room-id');

    /** 9자리 난수. Math.random 이 아니라 crypto 를 쓴다 — 방 번호가 예측되면 안 된다. */
    const generate = (): number => {
        const min = 100000000;
        const max = 999999999;
        return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
    };

    let roomNumber = 0;

    try {
        if (fs.existsSync(secretRoomFile)) {
            roomNumber = parseInt(fs.readFileSync(secretRoomFile, 'utf8').trim(), 10);
            if (!Number.isFinite(roomNumber) || roomNumber <= 0) {
                throw new Error('저장된 방 번호가 올바르지 않습니다');
            }
            logger.info('Loading existing secret administrative room number');
        } else {
            roomNumber = generate();
            fs.writeFileSync(secretRoomFile, String(roomNumber), 'utf8');
            fs.chmodSync(secretRoomFile, 0o600);
            logger.info('Generated new secret administrative room number and saved for future use');
        }
    } catch (error) {
        logger.error('Error handling secret room file, generating new number:', error);
        // 저장은 못 했지만 방은 있어야 한다. 이번 기동에만 유효한 번호를 쓴다.
        roomNumber = generate();
    }

    if (roomTable.createRoom(roomNumber, 'admin')) {
        logger.info('Secret administrative room has been created and is ready for private access');
    } else {
        logger.error('Failed to create secret administrative room');
    }
}

async function main(): Promise<void> {
    logger.info(`${config.serviceName} 시작`);
    logConfiguration();

    // DB 상태를 리슨보다 먼저 한 번 확인하고, 이후 주기적으로 갱신한다.
    // 실패해도 던지지 않는다 — 준비 안 됨 상태로 뜨고 /health 가 degraded 를
    // 보고하며, DB 가 필요한 라우트만 실패한다.
    //
    // ⚠️ 스키마는 여기서 만들지 않는다. `npm run db:migrate` 가 한다.
    await DbConn.monitor();

    const app = createApp();
    const server = http.createServer(app);
    const roomTable = new RtcRoomTable(config.ws.registerTimeoutMs);

    /**
     * 무엇이 치명적인지 여기서 분명히 한다.
     *
     * uncaughtException 처리기가 더 이상 종료하지 않으므로, 기동 실패
     * (EADDRINUSE 등)를 그냥 두면 듣지도 못하는 프로세스가 남아 pm2 는
     * 정상으로 본다. 그래서 아직 listen 하지 못한 단계의 오류만 종료로
     * 처리하고, 이미 서비스 중일 때 나는 소켓 오류는 기록만 한다.
     */
    server.on('error', (err: NodeJS.ErrnoException) => {
        if (!server.listening) {
            logger.error(`서버를 시작할 수 없습니다 (${config.host}:${config.port}): ${err.message}`);
            process.exit(1);
        }
        logger.error(`HTTP 서버 오류 (계속 실행): ${err.message}`);
    });

    server.listen(config.port, config.host, () => {
        const gateway = new RelayGateway(app, server, roomTable);
        gateway.hasDashboardBuild = hasDashboardBuild();
        // routes/* 와 /health 가 getGateway() 로 룸 테이블에 닿는다.
        // 이걸 빼먹으면 /status/* 와 대시보드가 통째로 503 을 준다.
        setGateway(gateway);

        // 관리용 비밀 방. 번호는 파일에 남아 재시작해도 유지된다.
        createSecretRoom(roomTable);

        // complex_id 가 비어 있는 행을 이 서버의 단지로 채운다.
        // SQL 마이그레이션은 .env 를 모르므로 여기서 한다 (libs/complex.ts).
        void backfillComplexId();

        // 만료된 등록 대기를 주기적으로 지운다. 조회가 이미 expires_at 으로
        // 거르므로 안전에 필요한 것은 아니고, 디스크 정리일 뿐이다.
        startPruneTimer();

        startWebsocketService(gateway);

        /*
         * Janus 는 토큰을 메모리에만 갖고 있다. 둘 다 재부팅했다면 Janus 는
         * 빈 상태로 떠 있고 우리 표에만 남아 있으므로, 여기서 다시 넣는다
         * (libs/janusToken.ts 의 재시작 대비 ②). 기다리지 않는다 — 실패해도
         * 앱이 재등록할 때 ①이 복구한다.
         */
        void janusToken.reconcile();

        logger.info(`${config.serviceName} 대기 중 — http://${config.host}:${config.port} (WS: /rtc, /iot)`);
    });

    /**
     * pm2 restart/stop 은 SIGTERM 을, Ctrl-C 는 SIGINT 를 보낸다.
     * 처리기가 없으면 연결이 정리되지 않은 채 프로세스가 끊긴다.
     */
    const shutdown = (signal: string) => {
        logger.info(`${signal} 수신 — 종료합니다.`);
        server.close(async () => {
            await DbConn.close().catch(() => {});
            process.exit(0);
        });
        // 열린 WebSocket 때문에 close 가 안 끝날 수 있다. 5초면 포기한다.
        setTimeout(() => process.exit(0), 5000).unref();
    };

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => shutdown(signal));
    }
}

main().catch((err) => {
    logger.error(`부팅 실패: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
});
