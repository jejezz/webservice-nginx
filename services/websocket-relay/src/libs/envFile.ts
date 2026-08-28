/**
 * @file envFile.ts
 * @brief `.env` 의 **한 항목만** 고친다. 주석과 순서는 그대로 둔다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 대시보드에서 바꾼 설정(지금은 단지 ID)이 재시작 후에도 유지되어야 한다.
 * 메모리만 바꾸면 다음 재시작에 조용히 옛 값으로 돌아가는데, 그 사이에 등록한
 * 단말들이 어느 단지 것인지 알 수 없게 된다.
 *
 * ── 왜 파일을 다시 쓰지 않고 한 줄만 바꾸는가 ────────────────────
 * `.env` 는 사람이 손으로 관리하는 파일이고 주석이 많다 (각 값이 무슨 뜻인지,
 * 왜 그 값인지가 적혀 있다). dotenv 로 읽어 통째로 다시 쓰면 그게 전부 사라진다.
 * 그래서 정규식으로 해당 줄만 갈아 끼우고, 없으면 끝에 덧붙인다.
 *
 * scripts/lib/env.ts 에도 같은 함수가 있다. 그쪽은 서비스가 뜨기 전에 도는
 * 설치 스크립트용이라 서비스 코드를 import 하지 않는다 — 의도된 중복이다.
 */
import fs from 'fs';
import path from 'path';
import config from '../config';
import logger from './logger';

/** 서비스 디렉토리의 `.env`. */
export const ENV_PATH = path.join(config.root, '.env');

/**
 * `.env` 의 `KEY=값` 한 줄을 바꾼다. 파일이 없으면 만든다.
 *
 * 쓰기는 **원자적으로** 한다 — 임시 파일에 쓰고 rename 한다. 그냥 덮어쓰다
 * 중간에 죽으면 `.env` 가 잘린 채 남고, 그러면 다음 기동에서 DB 접속 정보까지
 * 통째로 사라진다. rename 은 같은 파일시스템 안에서 원자적이다.
 *
 * @throws 쓰지 못하면 던진다. 부르는 쪽이 사람에게 알려야 한다.
 */
export function setEnvValue(key: string, value: string): void {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        throw new Error(`올바르지 않은 환경 변수 이름입니다: ${key}`);
    }
    // 값에 줄바꿈이 들어가면 그 아래가 통째로 다른 항목이 된다.
    if (/[\r\n]/.test(value)) {
        throw new Error('환경 변수 값에 줄바꿈을 넣을 수 없습니다.');
    }

    let text = '';
    try {
        text = fs.readFileSync(ENV_PATH, 'utf8');
    } catch {
        // 없으면 새로 만든다.
    }

    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text)
        ? text.replace(pattern, line)
        : `${text.replace(/\n*$/, '\n')}${line}\n`;

    const tmp = `${ENV_PATH}.tmp-${process.pid}`;
    try {
        // .env 에는 비밀값이 들어갈 수 있으므로 임시 파일도 처음부터 0600 이다.
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, ENV_PATH);
        logger.info(`.env 갱신: ${key}`);
    } catch (err: any) {
        try { fs.unlinkSync(tmp); } catch { /* 이미 없으면 그만이다 */ }
        throw new Error(`.env 를 쓰지 못했습니다 (${ENV_PATH}): ${err.message}`);
    }
}
