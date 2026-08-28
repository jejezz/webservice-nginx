/**
 * @file gateway.ts
 * @brief 릴레이의 **실행 상태**를 담는 객체. 설정이 아니라 지금 돌고 있는 것들이다.
 *
 * ── 왜 index.ts 에서 떼어냈는가 ──────────────────────────────────
 * 통합 전에는 이 역할을 index.ts 의 `CallFusion` 싱글턴이 했다. 그런데
 * routes/* 와 libs/* 가 **표 이름 하나를 얻으려고** index 를 다시 import 하면서
 * 순환 참조가 생겼다 (index → websocketService → index). 타입으로만 쓰이는
 * 동안에는 컴파일 때 지워져 드러나지 않았지만, 값을 하나라도 가져오는 순간
 * 모듈 본문에서 그 값이 undefined 가 됐다. `libs/paths.ts` 는 그 사고를 피하려고
 * 만들어진 파일이었다.
 *
 * 이제 설정값은 config 가, 실행 상태는 이 객체가 갖는다. 어느 쪽도 index 를
 * 보지 않으므로 고리가 없다.
 */
import type express from 'express';
import type http from 'http';
import { RtcRoomTable } from './libs/rtcRoomTable';

export class RelayGateway {
    /** 프로세스가 뜬 시각. /health 의 uptimeSec 이 여기서 나온다. */
    public readonly startedAt = Date.now();

    /** 대시보드 빌드(web/dist)가 있는지. /health 가 degraded 판정에 쓴다. */
    public hasDashboardBuild = false;

    constructor(
        public readonly expressApp: express.Application,
        public readonly httpServer: http.Server,
        public readonly roomTable: RtcRoomTable,
    ) {}
}

/**
 * 지금 돌고 있는 게이트웨이.
 *
 * 서버가 다 뜨기 전에도 /health 는 답해야 하므로(manager 가 부팅 중에도 부른다)
 * 값이 아니라 **게터**로 꺼낸다 — 아직 null 이면 degraded 로 답한다.
 */
let current: RelayGateway | null = null;

export function setGateway(gateway: RelayGateway): void {
    current = gateway;
}

export function getGateway(): RelayGateway | null {
    return current;
}

export default RelayGateway;
