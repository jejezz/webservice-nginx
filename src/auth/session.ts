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
import path from 'path';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import logger from '../libs/logger';

export const SECRET_FILE =
    process.env.SESSION_SECRET_FILE || path.resolve(__dirname, '../../..', '.session-secret');
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
        res.status(401).json({
            error: 'unauthorized',
            message: '로그인이 필요합니다.',
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
