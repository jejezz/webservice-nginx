/**
 * @file siteSettings.ts
 * @brief **여러 서비스가 함께 쓰는 값**을 읽는다 (`site/settings.ini`).
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 설정 규약(docs/settings-contract.md)의 단위는 서비스 하나였다. 그래서 host 처럼
 * 다섯이 공유하는 값을 둘 자리가 없었고, 각자 자기 파일에 베껴 적었다.
 *
 * 그 대가를 실제로 치렀다. 앱에게 알려 줄 Janus 주소가 이 서비스의 `.env` 에는
 * 개발용 호스트로, 진짜 주소는 `tools/directory.json` 에 따로 적혀 있었다. 둘이
 * 어긋나도 서버는 멀쩡히 돌고 로그도 조용했다 — 단말에서 이름이 풀리지 않아
 * 통화가 안 된다는 것을 앱 쪽에서 알려 줄 때까지 아무도 몰랐다.
 *
 * ── 이 파일이 지켜야 하는 것 ─────────────────────────────────────
 * **아무것도 import 하지 않는다** (fs·path 말고는). `config.ts` 가 자기를
 * 세우는 도중에 부르므로, 여기서 config 를 되짚으면 순환이 된다.
 *
 * **없어도 돈다.** 파일이 없거나 비어 있으면 빈 값을 돌려주고, 부르는 쪽은
 * 예전처럼 `.env` 값을 쓴다. 사이트 층을 아직 만들지 않은 배치가 그대로
 * 동작해야 한다.
 *
 * ── 누가 이기는가 ────────────────────────────────────────────────
 * **`.env` 가 이긴다.** 사이트 값은 비어 있을 때만 쓰인다. 한 장비에서만 다르게
 * 두고 싶은 경우(개발기)를 막지 않기 위해서다 — 다만 그렇게 두면 어긋날 수
 * 있으므로, 무엇이 쓰였는지는 `npm run doctor` 가 말해 준다.
 */
import fs from 'fs';
import path from 'path';

/** 이 서비스에서 저장소 뿌리까지. services/websocket-relay → ../.. */
const SITE_FILE = path.resolve(__dirname, '..', '..', '..', '..', 'site', 'settings.ini');

export interface SiteSettings {
    host: string;
    complexId: string;
    sipDomain: string;
    /** 값을 실제로 읽었는가. 화면·점검이 출처를 말할 때 쓴다. */
    loaded: boolean;
    file: string;
}

/** `키 = 값` 만 읽는다. 섹션은 쓰지 않는다 (site/apply.sh 와 같은 규칙). */
function parse(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
}

let cached: SiteSettings | null = null;

export function siteSettings(): SiteSettings {
    if (cached) return cached;

    let values: Record<string, string> = {};
    let loaded = false;
    try {
        values = parse(fs.readFileSync(SITE_FILE, 'utf8'));
        loaded = true;
    } catch {
        // 없으면 없는 대로 간다. 이 층을 아직 만들지 않은 배치다.
    }

    cached = {
        host: (values.host ?? '').trim(),
        complexId: (values.complex_id ?? '').trim().toLowerCase(),
        sipDomain: (values.sip_domain ?? '').trim(),
        loaded,
        file: SITE_FILE,
    };
    return cached;
}

/**
 * 앱에게 알려 줄 Janus 주소. host 하나에서 만든다.
 *
 * 손으로 적던 값이라 개발용 호스트가 그대로 앱에 나간 적이 있다. 만들어 쓰면
 * 그 어긋남이 생길 자리가 없어진다.
 */
export function janusWsUrl(): string {
    const { host } = siteSettings();
    return host ? `wss://${host}/janus-ws` : '';
}
