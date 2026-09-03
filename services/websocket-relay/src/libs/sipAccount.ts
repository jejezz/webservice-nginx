/**
 * @file sipAccount.ts
 * @brief Kamailio 내선 계정을 **서버가 만들고 지운다.**
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 지금까지 SIP 계정은 사람이 `kamctl add` 로 만들고, 그 이름을 앱이
 * `sip_user` 로 보내 이었다. 두 손을 거치므로 어긋나기 쉽고, 어긋나면
 * **아무 오류 없이 착신만 0건**이 된다 — services/kamailio/check-push.sh 가
 * "이 흐름에서 가장 자주 비어 있는 자리" 라고 적어 둔 그 자리다.
 *
 * 승인하는 쪽이 번호와 계정을 함께 만들면 그 어긋남이 생길 자리가 없어진다.
 *
 * ── 어느 컬럼이 실제로 인증에 쓰이는가 ───────────────────────────
 * 이 서버의 kamailio.cfg 는 `calculate_ha1 = yes` · `password_column = password`
 * 다. 즉 **auth_db 는 평문 `password` 만 읽어 요청의 realm 으로 ha1 을 그때그때
 * 계산한다.** `ha1`/`ha1b` 는 조회에도 검증에도 쓰이지 않는다
 * (services/kamailio/accounts.md 에 실측이 적혀 있다).
 *
 * 그래도 둘을 채운다. 나중에 `calculate_ha1` 을 끄는 쪽으로 바꿀 때 계정을
 * 전부 다시 만들지 않아도 되고, `kamctl` 이 만든 행과 모양이 같아진다.
 *
 * ── 비밀번호를 우리가 들고 있지 않는다 ───────────────────────────
 * 발급한 값을 relay 의 표에 따로 저장하지 않는다. `subscriber.password` 가
 * 이미 평문이므로, 단말이 물어보면 그때 읽어서 준다 (routes/register.ts).
 * 두 곳에 두면 한쪽만 바뀌었을 때 어느 것이 맞는지 알 수 없다.
 */
import crypto from 'crypto';

import { DbConn } from './dbConnection';
import config from '../config';
import logger from './logger';
import { sipProxy } from './sipProxy';

/** 만들어 준 자격. 단말에게 그대로 내려간다. */
export interface SipCredential {
    user: string;
    domain: string;
    password: string;
    /** 이 단지의 Kamailio 주소. 감지하지도 설정하지도 않았으면 싣지 않는다 (libs/sipProxy.ts). */
    proxy?: string;
}

/** 감지·설정돼 있을 때만 proxy 를 얹는다. 없으면 앱이 빌드 시점 기본값을 쓴다. */
function withProxy<T extends object>(cred: T): T & { proxy?: string } {
    const proxy = sipProxy();
    return proxy ? { ...cred, proxy } : cred;
}

function md5(text: string): string {
    return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * 16진수 24자. 사람이 옮겨 적을 값이 아니므로 읽기 좋을 필요가 없고,
 * 특수문자를 넣지 않아 설정 파일·URI 어디에 들어가도 탈이 없다.
 */
function newPassword(): string {
    return crypto.randomBytes(12).toString('hex');
}

/**
 * 내선 계정을 만든다. 이미 있으면 **비밀번호를 새로 발급한다.**
 *
 * 같은 번호가 다시 승인되는 경우는 단말이 지워졌다가 그 자리를 다른 단말이
 * 받은 때다. 그때 옛 비밀번호가 그대로 살아 있으면 지워진 단말이 계속 등록할
 * 수 있으므로, 자리를 물려줄 때 자격도 함께 바뀌어야 한다.
 *
 * **던지지 않는다.** Kamailio 가 없거나 DB 가 막혀도 승인 자체는 이미 끝난
 * 일이다. 여기서 던지면 착신과 무관한 등록까지 통째로 실패한다.
 */
export async function provision(user: string): Promise<SipCredential | null> {
    if (!config.sip.provision) {
        logger.info(`SIP 계정 발급이 꺼져 있습니다 — ${user} 를 만들지 않습니다.`);
        return null;
    }

    const domain = config.sip.domain;
    const password = newPassword();

    try {
        await DbConn.execute(
            `INSERT INTO ${config.sip.subscriberTable} (username, domain, password, ha1, ha1b)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                password = VALUES(password), ha1 = VALUES(ha1), ha1b = VALUES(ha1b)`,
            [user, domain, password,
             md5(`${user}:${domain}:${password}`),
             md5(`${user}@${domain}:${domain}:${password}`)]);
        logger.info(`SIP 계정 발급: ${user}@${domain}`);
        return withProxy({ user, domain, password });
    } catch (err: any) {
        logger.error(`SIP 계정을 만들지 못했습니다 (${user}@${domain}): ${err.message}`);
        return null;
    }
}

/**
 * 있으면 그대로 쓰고, 없을 때만 만든다.
 *
 * ── 왜 provision 을 그대로 쓰면 안 되는가 ────────────────────────
 * `provision` 은 부를 때마다 비밀번호를 새로 발급한다. 자리를 다른 단말에게
 * 물려줄 때는 그것이 맞다 — 지워진 단말이 옛 비밀번호로 계속 등록하면 안 된다.
 *
 * 월패드는 반대다. **부팅할 때마다** 등록을 부르므로(`/register/complex_agents`
 * 는 upsert 다) 그때마다 돌리면, 이미 등록해 둔 값이 매번 어긋난다. 그래서
 * 되풀이해 불러도 같은 값이 나오는 길을 따로 둔다.
 */
export async function ensure(user: string): Promise<SipCredential | null> {
    const existing = await credentialFor(user);
    if (existing) return existing;
    return provision(user);
}

/**
 * 지금 걸려 있는 자격을 읽는다. 단말이 등록할 때 내려주려고 부른다.
 *
 * 없으면 null 이다 — 발급이 실패했거나, 번호를 받기 전에 만들어진 옛 단말이다.
 */
export async function credentialFor(user: string): Promise<SipCredential | null> {
    if (!user) return null;

    try {
        const rows = await DbConn.select(
            `SELECT password FROM ${config.sip.subscriberTable}
              WHERE username = ? AND domain = ?`,
            [user, config.sip.domain]);
        const password = rows[0]?.password;
        if (!password) return null;
        return withProxy({ user, domain: config.sip.domain, password });
    } catch (err: any) {
        logger.warn(`SIP 자격을 읽지 못했습니다 (${user}): ${err.message}`);
        return null;
    }
}

/**
 * 그 단말에 배정된 내선 번호. 없으면 null.
 *
 * `id` 와 `uuid` 중 하나로 찾는다 — 단말을 지우는 길이 세 군데인데(대시보드 ·
 * 내부 CRUD · /unregister) 저마다 쥐고 있는 열쇠가 다르다.
 */
export async function sipUserOf(where: { id?: number | string; uuid?: string }): Promise<string | null> {
    const [column, value] = where.id !== undefined ? ['id', where.id] : ['uuid', where.uuid];
    if (value === undefined || value === null || value === '') return null;

    try {
        const rows = await DbConn.select(
            `SELECT sip_user FROM ${config.tables.mobile} WHERE ${column} = ?`, [value]);
        return rows[0]?.sip_user || null;
    } catch (err: any) {
        logger.warn(`내선 번호를 읽지 못했습니다 (${column}=${value}): ${err.message}`);
        return null;
    }
}

/**
 * 이 단말에게 내려줄 자격. 등록(/register/mobile) 응답에 싣는다.
 *
 * ── 왜 푸시로 보내지 않는가 ──────────────────────────────────────
 * 승인 푸시에 비밀번호를 실으면 그 값이 **구글을 지나간다.** 단말이 다시
 * 등록할 때 주면 서버와 단말 사이에서 끝나고, 앱은 승인을 확인하려고 어차피
 * 다시 등록한다. 클라이언트 인증서도 같은 이유로 같은 자리에서 내려준다
 * (schema/006-device-cert.sql 의 "요청할 때만 서명한다").
 */
export async function credentialForDevice(uuid: string): Promise<SipCredential | null> {
    const user = await sipUserOf({ uuid });
    return user ? credentialFor(user) : null;
}

/**
 * 계정을 지운다. **단말을 지울 때 반드시 함께 부른다.**
 *
 * 이걸 빠뜨리면 relay 의 표에서는 사라진 단말이 SIP 로는 계속 등록할 수 있다.
 * 그 단말은 착신 푸시를 못 받으므로 조용하지만, 이미 깨어 있는 동안 걸려오는
 * 전화는 그대로 받는다.
 */
export async function revoke(user: string): Promise<void> {
    if (!user || !config.sip.provision) return;

    try {
        const result = await DbConn.execute(
            `DELETE FROM ${config.sip.subscriberTable} WHERE username = ? AND domain = ?`,
            [user, config.sip.domain]);
        if (result.affectedRows > 0) {
            logger.info(`SIP 계정 삭제: ${user}@${config.sip.domain}`);
        }
    } catch (err: any) {
        // 단말은 이미 지워졌다. 되돌리지 않고 남긴다 — 남은 계정은 사람이
        // check-accounts.sh 로 볼 수 있다.
        logger.error(`SIP 계정을 지우지 못했습니다 (${user}): ${err.message}`);
    }
}
