/**
 * @file sipProxy.ts
 * @brief 앱이 REGISTER 를 보낼 이 단지의 Kamailio 주소.
 *
 * ── 왜 값을 함수로 꺼내는가 ──────────────────────────────────────
 * 대시보드에서 바꿀 수 있으므로 프로세스 수명 동안 고정이 아니다.
 * `export const` 로 두면 이 모듈을 import 한 파일들이 **모듈 로드 시점의
 * 값을 각자 복사해 갖는다** — 여기서 고쳐도 sipAccount.ts 는 옛 값을 계속
 * 쓴다 (libs/complex.ts 의 complexId() 와 같은 이유·같은 자세).
 *
 * ── Kamailio 서버 자체를 바꾸는 게 아니다 ────────────────────────
 * 여기서 다루는 값은 **서버가 앱에게 알려 주는 주소**일 뿐이다. 잘못
 * 감지됐거나 오타가 났을 때 바로잡는 용도이지, 다른 Kamailio 로 옮기는
 * 기능이 아니다 — 그건 services/kamailio/install.sh 의 몫이다.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../config';
import { setEnvValue } from './envFile';
import logger from './logger';

export const SIP_PROXY_RE = /^sip:[^\s:]+:\d+$/;
export const SIP_PROXY_ERROR = 'sip:<주소>:<포트> 형식이어야 합니다 (예: sip:10.10.0.224:5060).';

/** services/kamailio/settings.ini 의 sip_listen_addr. 없으면 null. */
function kamailioListenAddr(): string | null {
    const file = path.resolve(__dirname, '..', '..', '..', '..', 'services', 'kamailio', 'settings.ini');
    try {
        const m = fs.readFileSync(file, 'utf8').match(/^[ \t]*sip_listen_addr[ \t]*=[ \t]*(\S+)[ \t]*$/m);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/** 이 장비 자신의, 사설망이 아닌 첫 IPv4. Kamailio settings.ini 도 없을 때의 마지막 수단이다. */
function primaryIPv4(): string | null {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs ?? []) {
            if (a.family === 'IPv4' && !a.internal) return a.address;
        }
    }
    return null;
}

/**
 * SIP 프록시 주소를 추정한다. Kamailio 와 Janus 는 반드시 한 PC 에 설치되므로
 * (services/janus/install.sh 의 resolve_lan 이 그 전제로 LAN IP 를 고른다),
 * Kamailio settings.ini 를 먼저 본다 — 없으면 이 서비스도 같은 장비에서
 * 돈다는 전제로 자신의 LAN IP 를 대신 쓴다.
 */
export function detectSipProxy(): string | null {
    const ip = kamailioListenAddr() || primaryIPv4();
    return ip ? `sip:${ip}:5060` : null;
}

// .env 가 못박아 두면 그 값이 이긴다 — 감지가 틀렸을 때 덮어쓸 길이 있어야 한다.
let current: string | null = config.sip.proxy || detectSipProxy();

/** 지금 앱에게 알려 줄 SIP 프록시. 매 호출마다 최신 값이다. */
export function sipProxy(): string | null {
    return current;
}

/**
 * SIP 프록시를 바꾼다. `.env` 에도 적어 재시작 후에도 유지되게 한다.
 *
 * `next` 를 비우면(null) 다시 자동 감지로 돌아간다 — 감지가 실패하는 장비에서
 * 빈 값을 강제로 남겨 두지 않기 위해서다.
 */
export function setSipProxy(next: string | null, actor: string): void {
    const before = current;
    current = next ?? detectSipProxy();
    setEnvValue('SIP_PROXY', next ?? '');
    logger.warn(`[audit] SIP 프록시 변경: ${before ?? '(없음)'} → ${current ?? '(없음)'} (by ${actor})`);
}
