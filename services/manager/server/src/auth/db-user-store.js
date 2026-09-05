const db = require('../db');
const password = require('./password');
const log = require('../logger');

/**
 * 승인 대기(approved=0) 행의 전역 상한.
 *
 * routes/api.js 의 IP 잠금은 **한 IP가 빠르게** 새 이메일을 만드는 것만
 * 막는다. 이메일을 바꾸듯 IP도 여러 개로 나눠(또는 아주 천천히) 흘리면 그
 * 잠금을 피해 간다 — 그래서 "지금 대기 중인 행이 몇 개인가" 라는, IP와
 * 무관한 두 번째 상한을 둔다. 정상적인 사용에서 승인 대기가 이 숫자를
 * 넘을 일은 없다(장비 하나에 관리자 후보가 그렇게 많지 않다) — 넘었다면
 * 거의 확실히 쌓이고 있는 것이다.
 */
const MAX_PENDING_SIGNUPS = 100;

/**
 * administrator 테이블 기반 사용자 저장소.
 *
 * 로그인 아이디는 이메일만 받는다.
 * 등록되지 않은 이메일로 로그인을 시도하면 approved=0 인 승인 요청 행을 만들고,
 * approved=1 이 되어야 실제 로그인이 성공한다.
 *
 * 비밀번호가 **새로 저장되는** 경우(신규 등록, 승인 전 재설정)에는 확인 입력을
 * 한 번 더 받는다. 확인 없이는 password_hash 를 쓰지 않는다 — 첫 시도의 오타가
 * 그대로 계정 비밀번호가 되어 버리는 것을 막기 위함이다. 그 오타는 승인이 난
 * **뒤에야** 드러나고, 그때는 왜 로그인이 안 되는지 알 길이 없다.
 *
 * authenticate() 반환값
 *   { status: 'ok', user }            인증 성공
 *   { status: 'pending' }             승인 대기 (요청이 새로 생겼거나 이미 대기 중)
 *   { status: 'confirm_required' }    확인 입력이 필요 (reason: signup | reset)
 *   { status: 'confirm_mismatch' }    두 비밀번호가 다름 (reason: signup | reset)
 *   { status: 'invalid' }             이메일/비밀번호 불일치
 *   { status: 'unavailable' }         DB 접속 실패
 *   { status: 'signup_disabled' }     승인 대기 행이 너무 많아 새 가입을 받지 않음 (MAX_PENDING_SIGNUPS)
 */
class DbUserStore {
  constructor() {
    if (!db.isConfigured()) {
      log.warn('auth.provider=db 이지만 database 설정이 비어 있습니다.');
    }
  }

  async findByEmail(email) {
    const rows = await db.query(
      'SELECT id, email, display_name, password_hash, approved, role FROM administrator WHERE email = ? LIMIT 1',
      [email]
    );
    return rows[0] || null;
  }

  async authenticate(email, plain, ctx = {}) {
    const normalized = String(email).trim().toLowerCase();

    let row;
    try {
      row = await this.findByEmail(normalized);
    } catch (err) {
      log.error(`DB lookup failed for ${normalized}: ${err.code || err.message}`);
      return { status: 'unavailable' };
    }

    /*
     * verifyOnly — **아무것도 만들지 않고 확인만 한다.**
     *
     * 로그인 화면은 처음 보는 이메일을 승인 요청으로 바꿔 주지만, 이미 로그인한
     * 사람에게 "지금 당신이 맞습니까" 를 묻는 자리(POST /verify-password)에서는
     * 그 부작용이 있으면 안 된다. 세션은 있는데 계정이 사라진 상태로 물으면
     * 엉뚱한 승인 요청이 생긴다 — 실제로 시험하다 하나 만들어 봤다.
     */
    if (!row && ctx.verifyOnly) return { status: 'invalid' };

    // 확인 입력은 **값이 왔을 때만** 검사한다. 빈 문자열도 '입력했다' 로 본다 —
    // 그래야 확인 칸을 비워 두고 보낸 것과 아예 보내지 않은 것이 갈린다.
    const confirm = ctx.passwordConfirm;
    const confirmed = confirm !== undefined && confirm !== null;
    const confirmMatches = confirmed && String(confirm) === String(plain);

    // 처음 보는 이메일 — 승인 요청으로 등록한다.
    // 여기서 입력한 비밀번호가 그대로 계정 비밀번호가 되므로 확인을 받는다.
    if (!row) {
      if (!confirmed) return { status: 'confirm_required', reason: 'signup' };
      if (!confirmMatches) return { status: 'confirm_mismatch', reason: 'signup' };

      // IP 잠금과는 별개인 전역 상한 — 위 MAX_PENDING_SIGNUPS 설명 참고.
      // 확인까지 다 받은 뒤(=정말 행을 만들기 직전)에만 본다. confirm_required
      // 단계에서 매번 세면 아직 안 만들 행까지 상한에 잡혀 무의미하다.
      let pendingCount;
      try {
        pendingCount = await this.countPending();
      } catch (err) {
        log.error(`Pending-count check failed for ${normalized}: ${err.code || err.message}`);
        return { status: 'unavailable' };
      }
      if (pendingCount >= MAX_PENDING_SIGNUPS) {
        log.warn(`Signup rejected — ${pendingCount} pending approvals already (${normalized})`);
        return { status: 'signup_disabled' };
      }

      try {
        await db.query(
          'INSERT INTO administrator (email, password_hash, approved) VALUES (?, ?, 0)',
          [normalized, password.hash(plain)]
        );
        await this.audit(null, 'signup_request', normalized, ctx.ip, '로그인 시도로 승인 요청 생성');
        log.info(`Signup request created: ${normalized}`);
      } catch (err) {
        // 동시에 두 번 시도한 경우 UNIQUE 제약에 걸릴 수 있다. 그때도 결과는 '대기'다.
        if (err.code !== 'ER_DUP_ENTRY') {
          log.error(`Signup request failed for ${normalized}: ${err.code || err.message}`);
          return { status: 'unavailable' };
        }
      }
      return { status: 'pending', firstRequest: true };
    }

    const ok = password.verifyHash(plain, row.password_hash);

    // 승인 대기 중에는 비밀번호를 다시 설정할 수 있게 둔다.
    // (처음 요청할 때 오타가 났어도 승인 전에 바로잡을 수 있다. 아직 접근 권한은 없다)
    // ⚠️ 확인만 하는 호출에서는 그 재설정도 하지 않는다.
    if (!row.approved) {
      // 비밀번호가 맞으면 그냥 대기 안내다. 바꿀 것이 없다.
      if (ok) return { status: 'pending', firstRequest: false };

      // 확인만 하는 호출에서는 재설정도 하지 않는다.
      if (ctx.verifyOnly) return { status: 'pending', firstRequest: false };

      // 계정 비밀번호를 바꾸는 일이므로 등록 때와 똑같이 확인을 받는다.
      if (!confirmed) return { status: 'confirm_required', reason: 'reset' };
      if (!confirmMatches) return { status: 'confirm_mismatch', reason: 'reset' };

      try {
        await db.query('UPDATE administrator SET password_hash = ? WHERE id = ?', [
          password.hash(plain),
          row.id,
        ]);
      } catch (err) {
        log.warn(`Pending password update failed for ${normalized}: ${err.message}`);
      }
      return { status: 'pending', firstRequest: false, passwordUpdated: true };
    }

    if (!ok) {
      await this.audit(normalized, 'login_fail', normalized, ctx.ip, '비밀번호 불일치').catch(() => {});
      return { status: 'invalid' };
    }

    try {
      await db.query(
        'UPDATE administrator SET last_login_at = NOW(), login_count = login_count + 1 WHERE id = ?',
        [row.id]
      );
      await this.audit(normalized, 'login_ok', normalized, ctx.ip, null);
    } catch (err) {
      // 기록 실패로 로그인을 막지는 않는다.
      log.warn(`Login bookkeeping failed for ${normalized}: ${err.message}`);
    }

    return {
      status: 'ok',
      user: {
        username: row.email,
        displayName: row.display_name || row.email,
        role: row.role,
      },
    };
  }

  async audit(actor, action, target, ip, detail) {
    try {
      await db.query(
        'INSERT INTO admin_audit_log (actor, action, target, ip, detail) VALUES (?, ?, ?, ?, ?)',
        [actor, action, target, ip || null, detail || null]
      );
    } catch (err) {
      log.warn(`Audit write failed (${action}): ${err.message}`);
    }
  }

  // --- 관리용 ---

  async list() {
    return db.query(
      `SELECT id, email, display_name, approved, role, requested_at, approved_at, approved_by,
              last_login_at, login_count
         FROM administrator
        ORDER BY approved ASC, requested_at ASC`
    );
  }

  /** 관리자 콘솔의 행 단위 조작용. 이메일은 바뀔 수 있으므로 id로 찾는다. */
  async getById(id) {
    const rows = await db.query(
      `SELECT id, email, display_name, approved, role, requested_at, approved_at, approved_by,
              last_login_at, login_count, created_at, updated_at
         FROM administrator
        WHERE id = ? LIMIT 1`,
      [Number(id)]
    );
    return rows[0] || null;
  }

  /**
   * 주어진 필드만 바꾼다. (undefined 인 항목은 건드리지 않는다)
   * approved 가 실제로 바뀔 때만 approved_at / approved_by 를 다시 쓴다.
   * 대상이 없으면 null, 있으면 갱신된 행을 돌려준다.
   */
  async updateById(id, patch, actor) {
    const current = await this.getById(id);
    if (!current) return null;

    const sets = [];
    const params = [];

    if (patch.email !== undefined) {
      sets.push('email = ?');
      params.push(String(patch.email).trim().toLowerCase());
    }
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(patch.displayName || null);
    }
    if (patch.role !== undefined) {
      sets.push('role = ?');
      params.push(patch.role || 'admin');
    }
    if (patch.plainPassword) {
      sets.push('password_hash = ?');
      params.push(password.hash(patch.plainPassword));
    }

    const nextApproved = patch.approved === undefined ? null : patch.approved ? 1 : 0;
    const approvedChanged = nextApproved !== null && nextApproved !== Number(current.approved);

    if (approvedChanged) {
      if (nextApproved === 1) {
        sets.push('approved = 1', 'approved_at = NOW()', 'approved_by = ?');
        params.push(actor || null);
      } else {
        sets.push('approved = 0', 'approved_at = NULL', 'approved_by = NULL');
      }
    }

    if (sets.length > 0) {
      params.push(Number(id));
      await db.query(`UPDATE administrator SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    const target = patch.email !== undefined ? String(patch.email).trim().toLowerCase() : current.email;
    if (approvedChanged) {
      await this.audit(actor, nextApproved === 1 ? 'approve' : 'revoke', target, null, null);
    }
    if (patch.plainPassword) {
      await this.audit(actor, 'password_change', target, null, null);
    }
    if (sets.length > 0 && !approvedChanged && !patch.plainPassword) {
      await this.audit(actor, 'update', target, null, null);
    }

    return this.getById(id);
  }

  async removeById(id, actor) {
    const current = await this.getById(id);
    if (!current) return false;

    const rows = await db.query('DELETE FROM administrator WHERE id = ?', [Number(id)]);
    if (rows.affectedRows > 0) await this.audit(actor, 'delete', current.email, null, null);
    return rows.affectedRows > 0;
  }

  async setApproved(email, approved, actor) {
    const normalized = String(email).trim().toLowerCase();
    const rows = await db.query(
      `UPDATE administrator
          SET approved = ?,
              approved_at = IF(? = 1, NOW(), NULL),
              approved_by = IF(? = 1, ?, NULL)
        WHERE email = ?`,
      [approved ? 1 : 0, approved ? 1 : 0, approved ? 1 : 0, actor || null, normalized]
    );
    if (rows.affectedRows > 0) {
      await this.audit(actor, approved ? 'approve' : 'revoke', normalized, null, null);
    }
    return rows.affectedRows > 0;
  }

  async create({ email, plainPassword, displayName, approved, role, actor }) {
    const normalized = String(email).trim().toLowerCase();
    const result = await db.query(
      `INSERT INTO administrator (email, display_name, password_hash, approved, role, approved_at, approved_by)
       VALUES (?, ?, ?, ?, ?, IF(? = 1, NOW(), NULL), IF(? = 1, ?, NULL))`,
      [
        normalized,
        displayName || null,
        password.hash(plainPassword),
        approved ? 1 : 0,
        role || 'admin',
        approved ? 1 : 0,
        approved ? 1 : 0,
        actor || null,
      ]
    );
    await this.audit(actor, 'create', normalized, null, approved ? 'approved on create' : 'pending');
    return this.getById(result.insertId);
  }

  async setPassword(email, plainPassword, actor) {
    const normalized = String(email).trim().toLowerCase();
    const rows = await db.query('UPDATE administrator SET password_hash = ? WHERE email = ?', [
      password.hash(plainPassword),
      normalized,
    ]);
    if (rows.affectedRows > 0) await this.audit(actor, 'password_change', normalized, null, null);
    return rows.affectedRows > 0;
  }

  async remove(email, actor) {
    const normalized = String(email).trim().toLowerCase();
    const rows = await db.query('DELETE FROM administrator WHERE email = ?', [normalized]);
    if (rows.affectedRows > 0) await this.audit(actor, 'delete', normalized, null, null);
    return rows.affectedRows > 0;
  }

  async countApproved() {
    const rows = await db.query('SELECT COUNT(*) AS n FROM administrator WHERE approved = 1');
    return Number(rows[0]?.n || 0);
  }

  /** MAX_PENDING_SIGNUPS 상한이 보는 값 — 지금 승인 대기 중인 행 수. */
  async countPending() {
    const rows = await db.query('SELECT COUNT(*) AS n FROM administrator WHERE approved = 0');
    return Number(rows[0]?.n || 0);
  }
}

module.exports = { DbUserStore };
