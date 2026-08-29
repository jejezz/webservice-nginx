#!/usr/bin/env tsx
/**
 * @file backfill-sip-number.ts
 * @brief 이미 승인된 단말에 **뒤늦게 번호를 준다.**
 *
 *   npm run sip:backfill                          무엇이 바뀌는지 보여주기만 한다
 *   npm run sip:backfill -- --apply               실제로 적용한다
 *   npm run sip:backfill -- --apply --overwrite   앱이 보낸 옛 내선도 덮어쓴다
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 번호를 배정하는 곳은 **승인**이다 (libs/enrollment.ts). 그런데 이미 승인된
 * 단말은 그 자리를 다시 지나가지 않으므로, 규칙이 생기기 전에 들어온 단말들은
 * 영영 번호가 없다. 그 단말들만 여기서 채운다.
 *
 * ── 왜 SQL 한 줄이 아닌가 ────────────────────────────────────────
 * 번호는 계산이고(동4+호4+순번2), 계산 규칙은 libs/sipNumber.ts 한 곳에 있다.
 * SQL 로 손수 만들면 규칙이 두 벌이 되고, 그 어긋남은 "인터폰이 건 번호로 그
 * 집을 못 찾는다" 로만 드러난다. 계정 발급도 같은 이유로 libs/sipAccount.ts 를
 * 그대로 부른다.
 *
 * 서비스가 쓰는 풀(src/libs/dbConnection)을 그대로 쓴다. scripts/lib/db.ts 의
 * 주석이 권하지 않는 방식이지만, 여기서는 **같은 규칙을 부르는 것**이 더
 * 중요하다. 끝나면 close() 로 닫으므로 프로세스가 매달리지 않는다.
 */
import { DbConn } from '../src/libs/dbConnection';
import { homeNumber, deviceNumber, nextFreeSeq, WALLPAD_SEQ } from '../src/libs/sipNumber';
import * as sipAccount from '../src/libs/sipAccount';
import { formatAddress } from '../src/libs/address';
import config from '../src/config';

const apply = process.argv.includes('--apply');
const overwrite = process.argv.includes('--overwrite');

interface Row {
    id: number;
    uuid: string;
    address: string;
    complex_id: string | null;
    sip_user: string | null;
    sip_seq: number | null;
}

/** 세대 하나를 키로 묶는다. UNIQUE 제약과 같은 조합이어야 한다. */
function homeKey(r: Row): string {
    return `${r.complex_id ?? ''} ${r.address}`;
}

async function main(): Promise<void> {
    if (!DbConn.isConfigured()) {
        console.error('  x DB 설정을 읽을 수 없습니다. .env 와 비밀번호 파일을 확인하세요.');
        process.exit(1);
    }

    console.log(`\n기존 단말 번호 백필 — ${config.tables.mobile}`);
    console.log(apply ? '적용합니다.\n' : '보여주기만 합니다 (--apply 를 붙이면 실제로 바뀝니다).\n');

    const rows = (await DbConn.select(
        `SELECT id, uuid, address, complex_id, sip_user, sip_seq
           FROM ${config.tables.mobile} ORDER BY complex_id, address, id`)) as unknown as Row[];

    if (rows.length === 0) {
        console.log('  등록된 단말이 없습니다.');
        return;
    }

    // 이미 쓰이고 있는 순번. 세대마다 따로 센다.
    const taken = new Map<string, Set<number>>();
    for (const r of rows) {
        if (r.sip_seq === null) continue;
        const key = homeKey(r);
        if (!taken.has(key)) taken.set(key, new Set());
        taken.get(key)!.add(Number(r.sip_seq));
    }

    let changed = 0;
    let skipped = 0;

    for (const r of rows) {
        const label = `${r.address} #${r.id}`;

        if (r.sip_seq !== null) {
            console.log(`  - ${label} 이미 ${r.sip_user} (건너뜀)`);
            continue;
        }

        if (homeNumber(r.address) === null) {
            console.log(`  ! ${label} 번호를 만들 수 없는 주소입니다 (숫자가 아니거나 5자리 이상)`);
            skipped++;
            continue;
        }

        // 앱이 보낸 옛 내선이 있으면 함부로 덮지 않는다. 손으로 만든 계정을
        // 쓰고 있을 수 있고, 덮으면 그 단말만 조용히 착신을 잃는다.
        if (r.sip_user && !overwrite) {
            console.log(`  ! ${label} 옛 내선 "${r.sip_user}" 이 있습니다 — 덮으려면 --overwrite`);
            skipped++;
            continue;
        }

        const key = homeKey(r);
        if (!taken.has(key)) taken.set(key, new Set());
        const used = taken.get(key)!;

        const seq = nextFreeSeq(used);
        if (seq === null) {
            console.log(`  ! ${label} 이 세대에 남은 자리가 없습니다`);
            skipped++;
            continue;
        }

        const sipUser = deviceNumber(r.address, seq) as string;

        if (!apply) {
            console.log(`  > ${label} ${r.sip_user ?? '없음'} => ${sipUser} (순번 ${seq})`);
            used.add(seq);
            changed++;
            continue;
        }

        // sip_seq IS NULL 을 조건에 남긴다. 이 스크립트를 두 번 돌리거나 그
        // 사이에 승인이 일어나도 이미 배정된 행을 덮지 않는다.
        const result = await DbConn.execute(
            `UPDATE ${config.tables.mobile}
                SET sip_seq = ?, sip_user = ?
              WHERE id = ? AND sip_seq IS NULL`,
            [seq, sipUser, r.id]);

        if (result.affectedRows === 0) {
            console.log(`  ! ${label} 그 사이에 번호가 배정됐습니다 — 건너뜁니다`);
            skipped++;
            continue;
        }

        used.add(seq);
        const cred = await sipAccount.provision(sipUser);
        console.log(`  o ${label} => ${sipUser}` + (cred ? ' · 계정 발급' : ' · 계정 발급 실패(로그 참고)'));
        changed++;
    }

    // ── 월패드 자리(00) ──
    //
    // 월패드는 rtc_homenet 에 있고 번호는 동/호에서 계산되므로, 표에 채울 것이
    // 없고 계정만 만들면 된다. 정상 경로는 월패드가 부팅하며 등록할 때 만들어
    // 지지만(libs/homenetRecord.ts), 이미 등록해 둔 세대는 그 자리를 다시
    // 지나가지 않는다.
    const homes = (await DbConn.select(
        `SELECT building, unit FROM ${config.tables.homenet} ORDER BY building, unit`)
    ) as unknown as { building: string; unit: string }[];

    for (const h of homes) {
        const user = deviceNumber(formatAddress(h.building, h.unit), WALLPAD_SEQ);
        const label = `${h.building}동 ${h.unit}호 월패드`;

        if (!user) {
            console.log(`  ! ${label} 번호를 만들 수 없는 주소입니다`);
            skipped++;
            continue;
        }
        if (await sipAccount.credentialFor(user)) {
            console.log(`  - ${label} 이미 ${user} (건너뜀)`);
            continue;
        }
        if (!apply) {
            console.log(`  > ${label} => ${user}`);
            changed++;
            continue;
        }

        const cred = await sipAccount.ensure(user);
        console.log(`  o ${label} => ${user}` + (cred ? ' · 계정 발급' : ' · 계정 발급 실패(로그 참고)'));
        changed++;
    }

    console.log(`\n${apply ? '적용' : '적용 예정'} ${changed}건` + (skipped ? ` · 건너뜀 ${skipped}건` : ''));
    if (!apply && changed > 0) {
        console.log('실제로 바꾸려면:  npm run sip:backfill -- --apply');
    }
}

main()
    .catch((err) => {
        console.error(`  x ${err?.message ?? err}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await DbConn.close();
    });
