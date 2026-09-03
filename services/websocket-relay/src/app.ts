/**
 * @file app.ts
 * @brief Express 앱 조립. **여기서는 라우트를 붙이기만 한다.**
 *
 * 서버를 띄우고 종료하는 일은 index.ts 가, 값 읽기는 config.ts 가 한다.
 *
 * ── 두 곳에 붙이는 이유 ──────────────────────────────────────────
 * 라우트를 Router 하나에 모아 **루트('/')와 nginx 접두사(config.basePath)**
 * 양쪽에 붙인다. nginx 의 proxy_pass 에 URI 가 없어 원본 경로(/relay/...)가
 * 그대로 오기 때문이다. 단말·Kamailio 는 포트로 직접(루트 경로), 사람은
 * nginx 를 거쳐(접두사) 같은 앱에 닿는다.
 *
 * ── 어떤 경로가 어디에 붙는가 ────────────────────────────────────
 * 이 구분이 이 파일의 핵심이고, **보안이 여기에 걸려 있다.**
 *
 *   라우터(router)에 붙인 것   → '/' 와 '/relay' 둘 다. 즉 nginx 로 노출된다.
 *   앱(app)에 직접 붙인 것     → '/' 뿐. nginx 를 거쳐서는 **닿을 수 없다.**
 *
 * 내부 전용 경로를 앱에만 붙이는 것은 IP 검사만으로는 부족하기 때문이다.
 * nginx 를 거쳐 들어온 요청은 소켓 주소가 늘 127.0.0.1(nginx) 이라 사설망
 * 검사를 무조건 통과한다. 경로 자체를 접두사 쪽에 만들지 않으면, 프록시로
 * 들어온 요청은 그 라우터에 해당 경로가 없어 404 로 끝난다.
 */
import fs from 'fs';
import path from 'path';
import express, { Application, Request, Response, NextFunction } from 'express';

import config from './config';
import logger from './libs/logger';
import { createHealthRouter } from './health';
import { requirePage } from './auth/session';
import { createDashboardApi } from './http/dashboardApi';

import Route2Register from './routes/register';
import Route2Unregister from './routes/unregister';
import Route2User from './routes/user';
import Route2Room from './routes/room';
import Route2Status from './routes/status';
import Route2Mobile from './routes/mobile';
import Route2SipPush from './routes/sipPush';

/**
 * 루프백과 사설 대역만 통과시킨다.
 *
 * **소켓의 실제 원격 주소만 본다.** 예전에는 X-Forwarded-For 가 있으면 그 값을
 * 그대로 신뢰했는데, 이 서비스가 0.0.0.0 으로 직접 노출돼 있던 시절에는
 * 외부에서 `X-Forwarded-For: 127.0.0.1` 을 붙이면 제한을 그냥 통과했다.
 * 헤더는 보낸 쪽이 정하는 값이라 신뢰할 수 있는 프록시를 거친 경우에만
 * 의미가 있다.
 *
 * 이 미들웨어를 쓰는 경로는 **앱에만** 붙어 있어 nginx 로는 닿을 수 없다.
 * 그러니 여기 도달하는 요청은 이미 포트 직결이고, 소켓 주소가 곧 상대다.
 * 두 겹으로 막는 셈이다 — 경로를 노출하지 않는 것이 1차, 이 검사가 2차.
 */
function internalOnly(req: Request, res: Response, next: NextFunction): void {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');

    const isLoopback = ip === '127.0.0.1' || ip === '::1';
    const isPrivate =
        /^10\./.test(ip) ||                          // 10.0.0.0/8
        /^192\.168\./.test(ip) ||                    // 192.168.0.0/16
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip);       // 172.16.0.0/12

    if (isLoopback || isPrivate) {
        next();
        return;
    }

    logger.warn(`내부 전용 경로 접근 거부: ${ip || '(주소 없음)'} ${req.method} ${req.originalUrl}`);
    res.status(403).json({
        error: 'Access Denied',
        message: '내부 네트워크에서만 접근할 수 있습니다.',
    });
}

export function createApp(): Application {
    const app = express();

    app.set('strict routing', true);
    app.set('case sensitive routing', true);

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    const router = express.Router();

    // ── 인증도 제한도 없는 것 ────────────────────────────────────
    // /health 는 어떤 제한보다 앞에 둔다 (docs/health-contract.md).
    router.use('/health', createHealthRouter());

    // 서비스 소개. 예전에는 여기서 무인증 관리 페이지(room_status.html)를 내보냈다.
    router.get('/', (_req: Request, res: Response) => {
        res.json({
            service: config.serviceName,
            status: 'ok',
            dashboard: `${config.basePath}${config.dashboardPath}`,
        });
    });

    // ── 단말이 쓰는 공개 API ─────────────────────────────────────
    router.use('/register', Route2Register);
    router.use('/unregister', Route2Unregister);
    router.use('/room', Route2Room);
    // 방 상태 조회. Android 클라이언트가 쓴다 (example/android, ANDROID_API_GUIDE.md).
    // ⚠️ 응답에 접속자의 address·ipAddress 가 들어간다. 공개 경로에 두는 것은
    //    문서화된 클라이언트를 깨지 않기 위한 선택이지, 안전해서가 아니다.
    router.use('/status', Route2Status);

    // WS 에코 시험 도구는 대시보드의 '연결 테스트' 탭이 대신한다.
    //
    // 여기 있던 /tests(public/echo_client.html)는 `/relay/iot` 이 하드코딩되어
    // 있어 RTC 경로를 확인할 수 없었다. 옛 주소를 누르는 사람이 헤매지 않도록
    // 새 자리로 넘겨 준다. (둘 다 manager 로그인을 요구하므로 접근 범위는 같다)
    router.get('/tests', requirePage, (_req: Request, res: Response) => {
        res.redirect(302, `${config.basePath}${config.dashboardPath}/tester`);
    });

    // ── 내부 전용 — 앱에만 붙는다 (nginx 로는 닿지 않는다) ───────
    //
    // 단말 관리 CRUD. 사람이 쓰는 관리 화면은 세션을 요구하는 /dashboard 쪽에 있다.
    app.use('/mobile-crud-operation', internalOnly, Route2Mobile);

    // 등록된 단말 목록.
    //
    // ⚠️ 여기 있었던 자리가 바뀌었다. 예전에는 라우터에 붙어 있어
    //    `https://<호스트>/relay/user/all` 이 **인증 없이** 열려 있었고,
    //    등록된 주민 전원의 이메일·주소·전화번호를 그대로 내려줬다.
    //    통합하며 다른 관리 경로와 같은 자리로 옮긴다. 사람이 볼 목록은
    //    로그인을 요구하는 대시보드 API(/dashboard/api/mobiles)에 있다.
    app.use('/user', internalOnly, Route2User);

    // Kamailio 착신 푸시 — 루프백 전용 (검사는 라우터 안에 있다).
    // Kamailio 는 같은 호스트에 있으므로 포트 직결로 부른다. 프록시로 노출되면
    // 외부에서 남의 단말을 임의로 깨울 수 있게 된다.
    app.use('/sip-push', Route2SipPush);

    // ── 루트와 nginx 접두사 양쪽에 같은 라우터를 붙인다 ──────────
    app.use('/', router);
    app.use(config.basePath, router);

    // ── 관리 대시보드 — **접두사 아래에만** 붙는다 ───────────────
    //
    // 위의 공용 라우터에 두지 않는 이유: 그러면 `/dashboard` 로도 열려서, nginx 를
    // 거치지 않고 포트로 직접 들어온 요청에도 관리 화면이 나온다. 지금은 루프백에만
    // 묶여 있어 같은 호스트에서만 가능하지만, 입구를 하나로 두는 편이 낫다 —
    // "manager 를 거쳐 들어온다" 가 이 대시보드의 유일한 접근 경로다.
    //
    // 인증은 경로가 아니라 세션이 한다. 아래 requirePage/requireAuth 가
    // manager 가 발급한 쿠키를 검증하고, 만료된 토큰은 거부한다 (auth/session.ts).
    app.use(`${config.basePath}${config.dashboardPath}`, createDashboardRouter());

    app.use((req: Request, res: Response) => {
        res.status(404).json({ error: 'Not Found', path: req.path });
    });

    // Express 4 는 인자 4개짜리 함수만 오류 핸들러로 인식한다.
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        logger.error(`처리되지 않은 요청 오류: ${err.stack || err.message}`);
        res.status(500).json({ error: 'Internal Server Error' });
    });

    return app;
}

/**
 * 관리 대시보드 라우터.
 *
 * manager 로그인 세션 하나로 들어온다. 이 서비스는 계정을 따로 두지 않고
 * 검증만 한다 (auth/session.ts). 이전에는 같은 정보를 무인증 HTML 페이지로
 * 그대로 내보냈다.
 *
 * **정적 에셋에도 세션을 요구한다.** 예전에는 "데이터가 없는 JS/CSS 라" 열어
 * 뒀는데, 그러면 로그인하지 않은 사람도 관리 화면의 번들을 받아 어떤 API 가
 * 어떤 모양으로 있는지 전부 읽을 수 있다. 데이터가 없다는 것과 알려 줄 것이
 * 없다는 것은 다르다. 에셋은 페이지가 불러오므로 쿠키가 함께 가고, 캐시는
 * 파일 이름에 해시가 붙어 있어 그대로 유효하다.
 */
function createDashboardRouter(): express.Router {
    const router = express.Router();
    const indexHtml = path.join(config.dashboardDir, 'index.html');

    // API 는 401 JSON 으로 답한다 — 화면이 그걸 보고 로그인으로 보낸다.
    router.use('/api', createDashboardApi());

    if (!fs.existsSync(indexHtml)) {
        logger.warn(`대시보드 빌드를 찾을 수 없습니다: ${config.dashboardDir} — "npm run web:build"`);
        router.get('*', (_req: Request, res: Response) => {
            res.status(503).type('text/plain')
                .send('Dashboard build not found. Run: cd services/websocket-relay && npm run web:build');
        });
        return router;
    }

    router.use('/assets', requirePage, express.static(path.join(config.dashboardDir, 'assets'), {
        immutable: true,
        maxAge: '1y',
    }));

    // 페이지는 로그인 상태에서만 열리며, 아니면 manager 로그인으로 보낸다.
    // SPA 라 어떤 경로로 들어와도 같은 index.html 을 준다.
    router.get('*', requirePage, (_req: Request, res: Response) => {
        // 로그아웃한 뒤 뒤로 가기로 화면이 되살아나지 않게 한다.
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(indexHtml);
    });

    return router;
}

/** 대시보드 빌드가 있는지. index.ts 가 기동 로그와 /health 에 싣는다. */
export function hasDashboardBuild(): boolean {
    return fs.existsSync(path.join(config.dashboardDir, 'index.html'));
}

export default createApp;
