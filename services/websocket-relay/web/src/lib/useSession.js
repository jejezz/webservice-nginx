import { useEffect, useState } from 'react';
import { api, redirectToLogin } from '@/lib/api';

/**
 * manager 세션의 남은 시간을 지켜본다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 서버는 요청마다 토큰 만료를 확인하고 401 을 준다. 그것만으로도 안전하지만,
 * **사람에게는 아무 예고가 없다.** 단말 정보를 고치다가 저장을 누르는 순간
 * 로그인 화면으로 튕기고, 입력하던 내용은 사라진다. 세션 기본값이 2시간이라
 * 오후 내내 열어 두면 실제로 겪는 일이다.
 *
 * 그래서 만료 시각을 미리 받아 두고 남은 시간을 보여 준다. 5분이 남으면
 * 경고하고, 실제로 만료되면 다음 요청을 기다리지 않고 로그인으로 보낸다.
 *
 * ── 왜 서버 시각을 쓰지 않는가 ───────────────────────────────────
 * expiresAt 은 manager 가 토큰에 넣은 **절대 시각(ms)** 이다. 브라우저 시계가
 * 서버와 크게 어긋나 있으면 남은 시간이 틀리게 보인다. 그래도 판정 자체는
 * 늘 서버가 하므로(401), 여기 계산은 안내용일 뿐 권한과 무관하다.
 */

/** 이 아래로 내려가면 경고를 띄운다. */
export const WARN_MS = 5 * 60 * 1000;

export function useSession() {
    const [user, setUser] = useState(null);
    const [remainingMs, setRemainingMs] = useState(null);

    useEffect(() => {
        let alive = true;
        // 실패하면 request() 가 이미 로그인으로 보냈다. 여기서 더 할 일이 없다.
        api.me().then((r) => { if (alive) setUser(r.user); }).catch(() => {});
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (!user?.expiresAt) return undefined;

        const tick = () => {
            const left = user.expiresAt - Date.now();
            setRemainingMs(left);
            if (left <= 0) redirectToLogin();
        };

        tick();
        // 여유가 있을 때는 느슨하게, 임박하면 초 단위로. 2시간 내내 1초마다
        // 다시 그릴 이유가 없다.
        const soon = user.expiresAt - Date.now() < 10 * 60 * 1000;
        const timer = setInterval(tick, soon ? 1000 : 30000);
        return () => clearInterval(timer);
        // remainingMs 가 10분을 지나면 주기를 다시 잡는다.
    }, [user, remainingMs !== null && remainingMs < 10 * 60 * 1000]);

    return {
        user,
        remainingMs,
        expiring: remainingMs !== null && remainingMs <= WARN_MS,
    };
}

/** 남은 시간을 사람이 읽는 모양으로. 1시간 넘으면 분 단위로 충분하다. */
export function formatRemaining(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms <= 0) return '만료됨';

    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;

    if (h > 0) return `${h}시간 ${m}분`;
    if (m >= 10) return `${m}분`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}
