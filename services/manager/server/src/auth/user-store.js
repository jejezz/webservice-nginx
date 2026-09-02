const password = require('./password');
const log = require('../logger');
const { DbUserStore } = require('./db-user-store');

/**
 * 사용자 저장소 인터페이스.
 *
 *   authenticate(email, plainPassword, ctx) -> {
 *     status: 'ok' | 'pending' | 'invalid' | 'unavailable',
 *     user?: { username, displayName, role }
 *   }
 *
 * provider 별 구현:
 *   db   — administrator 테이블 (기본). 승인 절차를 지원한다.
 *   file — config.json의 auth.users. DB 장애 시를 위한 비상용이며 승인 절차가 없다.
 */
class FileUserStore {
  constructor(users) {
    this.users = Array.isArray(users) ? users : [];

    if (this.users.length === 0) {
      log.warn('auth.provider=file 이지만 등록된 사용자가 없습니다. 로그인이 항상 실패합니다.');
    }

    const plainTextUsers = this.users.filter((u) => u.password && !u.passwordHash);
    if (plainTextUsers.length > 0) {
      log.warn(
        `Plain-text password in config for: ${plainTextUsers.map((u) => u.username).join(', ')}. ` +
          'Use "npm run hash-password -- <password>" and store the result as "passwordHash".'
      );
    }
  }

  async authenticate(username, plain) {
    const normalized = String(username).trim().toLowerCase();
    const user = this.users.find((u) => String(u.username).toLowerCase() === normalized);

    if (!user) {
      // 사용자 존재 여부가 응답 시간으로 드러나지 않도록 더미 해시를 계산한다.
      password.verifyHash(plain, 'scrypt$00$00');
      return { status: 'invalid' };
    }

    const ok = user.passwordHash
      ? password.verifyHash(plain, user.passwordHash)
      : password.timingSafeEqualStr(plain, user.password ?? '');

    if (!ok) return { status: 'invalid' };

    return {
      status: 'ok',
      user: {
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role || 'admin',
      },
    };
  }
}

function createUserStore(authConfig = {}) {
  const provider = authConfig.provider || 'db';

  switch (provider) {
    case 'db':
      return new DbUserStore();
    case 'file':
      log.warn('auth.provider=file — 비상용 설정입니다. 평상시에는 db 를 사용하세요.');
      return new FileUserStore(authConfig.users);
    default:
      throw new Error(`Unknown auth provider: ${provider}`);
  }
}

module.exports = { createUserStore, FileUserStore, DbUserStore };
