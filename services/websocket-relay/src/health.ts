/**
 * @file health.ts
 * @brief `/health` — ../../docs/health-contract.md 규약.
 *
 * manager 대시보드가 서비스 상태를 판정하는 데 쓴다. 지켜야 할 것 셋:
 *
 *  1. **인증 없이** 응답한다. manager 는 루프백에서 인증 없이 부른다.
 *  2. **IP 제한·인증 미들웨어보다 앞에** 둔다.
 *  3. **가볍다.** 5초마다 불리므로 여기서 DB 를 때리면 안 된다 —
 *     이전 판은 매 호출마다 `SELECT 1` 을 보냈다. 지금은 dbConnection 의
 *     주기 점검이 갱신해 둔 **캐시된 값**만 읽는다.
 *
 * 라우터에 붙이는 이유: 라우터는 루트('/')와 접두사(config.basePath) 양쪽에
 * 마운트되므로 `/health` 와 `/relay/health` 가 모두 열린다. 앱에만 붙여 두면
 * 접두사 경로가 404 가 되어, manager 가 표시하는 공개 경로와 실제가 어긋난다.
 */
import { Router, Request, Response } from 'express';
import config from './config';
import { getGateway } from './gateway';
import { DbConn } from './libs/dbConnection';
import { Firebase } from './libs/firebaseAdmin';

// package.json 의 version. dist/ 에서 실행돼도 서비스 디렉토리에서 찾는다.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require(`${config.root}/package.json`) as { version?: string };

export function createHealthRouter(): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response) => {
        const gateway = getGateway();
        const dbReady = DbConn.isConfigured() && DbConn.isReady();

        /**
         * 떠 있지만 온전하지 않은 두 경우를 degraded 로 본다.
         *
         *  - 릴레이가 아직 안 뜸 (부팅 중)
         *  - DB 가 끊김. WebSocket 중계 자체는 계속 되지만 단말 등록과 푸시
         *    대상 조회가 안 된다.
         *
         * 200 + degraded 로 답한다 — 503 을 주면 대시보드에 '중단' 으로 잡히는데,
         * 중계는 살아 있으므로 완전 중단으로 표시하고 싶지는 않다.
         * (예전에는 DB 가 끊겨도 ok 로 답해 대시보드가 아무것도 알려주지 않았다.)
         */
        const status = gateway && dbReady ? 'ok' : 'degraded';

        res.status(200).json({
            service: config.serviceName,
            status,
            version: pkg.version || '0.0.0',
            uptimeSec: gateway ? Math.floor((Date.now() - gateway.startedAt) / 1000) : 0,
            pid: process.pid,
            timestamp: new Date().toISOString(),
            details: {
                rooms: gateway ? gateway.roomTable.roomTable.size : 0,
                websockets: gateway ? gateway.roomTable.websocketCount() : 0,
                memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                nodeEnv: config.env,
                complexId: config.complexId,
                // 푸시는 선택적 의존성이다. 꺼져 있어도 중계 자체는 정상이므로
                // status 를 떨어뜨리지 않고 여기에만 적는다.
                pushEnabled: Firebase.isConfigured(),
                database: {
                    configured: DbConn.isConfigured(),
                    ready: dbReady,
                    name: config.db.name,
                    error: DbConn.lastErrorMessage(),
                },
                dashboardBuild: gateway ? gateway.hasDashboardBuild : false,
            },
        });
    });

    return router;
}

export default createHealthRouter;
