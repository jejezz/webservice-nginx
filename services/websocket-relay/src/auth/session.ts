/**
 * @file session.ts
 * @brief manager 가 발급한 세션 쿠키를 검증한다.
 *
 * 서비스마다 로그인을 따로 두지 않고, manager 로그인 하나로 모든 대시보드를 쓴다.
 * manager 와 같은 시크릿(services/.session-secret)으로 HMAC 을 검증하며,
 * manager 쿠키의 Path 가 '/' 이므로 이 서비스의 요청에도 함께 전달된다.
 *
 * 계정 관리는 manager 한 곳에서 한다. 여기서는 검증만 한다.
 * (services/ws-bridge/src/auth/session.js 와 같은 규약)
 */
import fs from 'fs';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import config from '../config';
import logger from '../libs/logger';

export const SECRET_FILE = config.session.secretFile;
export const COOKIE_NAME = 'manager_session';

export interface SessionUser {
    username: string;
    displayName: string;
    expiresAt: number;
}

let secret: string | null = null;
let secretLoaded = false;

function loadSecret(): string | null {
    if (secretLoaded) return secret;
    secretLoaded = true;

    try {
        secret = fs.readFileSync(SECRET_FILE, 'utf8').trim() || null;
    } catch {
        secret = null;
    }

    if (!secret) {
        logger.warn(`세션 시크릿을 찾을 수 없습니다 (${SECRET_FILE}). 대시보드 접근이 모두 거부됩니다.`);
    }
    return secret;
}

function parseCookies(header?: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;

    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const name = part.slice(0, idx).trim();
        if (!name) continue;
        const raw = part.slice(idx + 1).trim();
        try {
            out[name] = decodeURIComponent(raw);
        } catch {
            out[name] = raw;
        }
    }
    return out;
}

function verifyToken(token?: string): SessionUser | null {
    const key = loadSecret();
    if (!key || typeof token !== 'string') return null;

    const [payloadB64, signature] = token.split('.');
    if (!payloadB64 || !signature) return null;

    const expected = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let payload: any;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    if (!payload.exp || Date.now() >= payload.exp) return null;

    /**
     * 관리자 콘솔(super) 토큰은 여기서 받지 않는다.
     *
     * manager 는 토큰을 두 종류로 발급한다 — 일반 세션과, 설정 화면에 쓰는
     * 관리자 콘솔 토큰(payload.s === 'super', TTL 이 더 짧다). manager 자신의
     * `verify()` 는 일반 세션 자리에 super 토큰이 오면 거부하는데
     * (services/manager/server/src/auth/session.js), 이쪽 검증에는 그 규칙이
     * 빠져 있어 **manager 가 거부하는 토큰을 이 대시보드는 받아들였다.**
     *
     * 두 토큰은 같은 시크릿으로 서명되므로 서명만으로는 구분되지 않는다.
     * 발급하는 쪽의 규약을 그대로 따라 여기서도 막는다.
     */
    if (payload.s) return null;

    return { username: payload.u, displayName: payload.n, expiresAt: payload.exp };
}

export function userFromRequest(req: Request): SessionUser | null {
    const cookies = parseCookies(req.headers.cookie);
    return verifyToken(cookies[COOKIE_NAME]);
}

/** API 용 — 인증 실패 시 401 JSON */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const user = userFromRequest(req);
    if (!user) {
        // 캐시에 남아 이전 응답이 재사용되는 일이 없도록 못 박는다.
        res.setHeader('Cache-Control', 'no-store');
        res.status(401).json({
            error: 'unauthorized',
            message: '세션이 만료되었거나 로그인이 필요합니다.',
            loginUrl: '/manager/login',
        });
        return;
    }
    (req as any).user = user;
    next();
}

/** 페이지 용 — 인증 실패 시 manager 로그인으로 보낸다 */
export function requirePage(req: Request, res: Response, next: NextFunction): void {
    const user = userFromRequest(req);
    if (!user) {
        res.redirect(302, `/manager/login?next=${encodeURIComponent(req.originalUrl)}`);
        return;
    }
    (req as any).user = user;
    next();
}
