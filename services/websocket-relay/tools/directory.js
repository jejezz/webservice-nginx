#!/usr/bin/env node
/**
 * @file tools/directory.js
 * @brief 단지 디렉터리를 Firestore 에 올리고 확인한다.
 *
 *   node tools/directory.js check                  자격·연결만 확인 (아무것도 쓰지 않음)
 *   node tools/directory.js pull                   지금 올라가 있는 내용을 보여준다
 *   node tools/directory.js push directory.json    파일 내용을 올린다
 *   node tools/directory.js push directory.json --dry-run
 *
 * ── 왜 이 서비스에 있나 ──────────────────────────────────────────
 * Firebase 서비스 계정 키를 가진 곳이 여기뿐이기 때문입니다(secrets/).
 * 디렉터리 자체는 이 서버의 기능이 아니라 **한 번씩 돌리는 운영 도구**라서
 * src/ 가 아니라 tools/ 에 둡니다.
 *
 * ── 구조 ─────────────────────────────────────────────────────────
 * 지역당 문서 하나입니다. 단지당 문서로 나누면 목록을 그릴 때 단지 수만큼
 * 읽기가 발생합니다. 이 구조면 앱이 몇 개 단지를 보든 `2 reads` 로 끝납니다.
 *
 *   regions/_index          지역 목록만
 *   regions/{regionCode}    그 지역의 단지 배열
 *
 * 자세한 설계는 docs/multi-complex.md 를 보세요.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_DIR = path.resolve(__dirname, '..');
const KEY_FILE = path.resolve(
    SERVICE_DIR,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'secrets/firebase-admin.json'
);

/** 단지 ID 형식 — 32비트를 소문자 16진수 8자로 (src/libs/complex.ts 와 같은 규칙). */
const COMPLEX_ID_RE = /^[0-9a-f]{8}$/;

function die(msg, hint) {
    console.error(`\n오류: ${msg}`);
    if (hint) console.error(hint);
    process.exit(1);
}

function init() {
    if (!fs.existsSync(KEY_FILE)) {
        die(`서비스 계정 키가 없습니다: ${KEY_FILE}`,
            'Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성');
    }
    const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(key) });
    return { key, db: admin.firestore() };
}

/**
 * 올릴 내용을 검사한다. **올리기 전에 다 본다** — 절반만 올라가면 앱이
 * 목록에는 있는데 열 수 없는 단지를 보게 된다.
 */
function validate(doc) {
    const problems = [];
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.regions)) {
        problems.push("최상위에 regions 배열이 있어야 합니다.");
        return problems;
    }
    const seenRegion = new Set();
    const seenComplex = new Map();   // complexId -> 어디서 나왔는지

    for (const [i, r] of doc.regions.entries()) {
        const where = `regions[${i}]`;
        if (!r.code) problems.push(`${where}: code 가 없습니다.`);
        if (!r.name) problems.push(`${where}: name 이 없습니다.`);
        if (r.code && seenRegion.has(r.code)) problems.push(`${where}: 지역 코드가 겹칩니다 — ${r.code}`);
        if (r.code) seenRegion.add(r.code);

        if (!Array.isArray(r.complexes)) {
            problems.push(`${where}: complexes 배열이 없습니다.`);
            continue;
        }
        for (const [j, c] of r.complexes.entries()) {
            const cw = `${where}.complexes[${j}]`;
            if (!COMPLEX_ID_RE.test(String(c.complexId || ''))) {
                problems.push(`${cw}: complexId 는 소문자 16진수 8자여야 합니다 — ${c.complexId}`);
            }
            if (!c.name) problems.push(`${cw}: name 이 없습니다.`);
            if (!c.host) problems.push(`${cw}: host 가 없습니다.`);
            // 단지 ID 는 전체에서 유일해야 한다. 겹치면 두 단지가 같은 서버로 간다.
            if (c.complexId && seenComplex.has(c.complexId)) {
                problems.push(`${cw}: complexId 가 겹칩니다 — ${c.complexId} (${seenComplex.get(c.complexId)} 와 중복)`);
            }
            if (c.complexId) seenComplex.set(c.complexId, cw);
        }
    }
    return problems;
}

async function cmdCheck() {
    const { key } = init();
    console.log(`프로젝트   ${key.project_id}`);
    console.log(`서비스계정 ${key.client_email}`);
    console.log(`키 ID      ${key.private_key_id}`);
    console.log('\n토큰을 받아 봅니다...');
    try {
        await admin.credential.cert(key).getAccessToken();
        console.log('  ✅ 자격 정상');
    } catch (err) {
        console.log(`  ❌ ${err.message}`);
        if (String(err.message).includes('account not found')) {
            console.log('\n  → 서비스 계정이 존재하지 않습니다. 키가 폐기됐거나 프로젝트가 지워졌습니다.');
            console.log('     Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성');
        }
        process.exit(1);
    }
    const db = admin.firestore();
    const snap = await db.collection('regions').get();
    console.log(`\nFirestore 연결 정상 — regions 문서 ${snap.size}개`);
}

async function cmdPull() {
    const { db } = init();
    const snap = await db.collection('regions').get();
    if (snap.empty) return console.log('regions 컬렉션이 비어 있습니다.');
    for (const d of snap.docs) {
        const v = d.data();
        if (d.id === '_index') {
            console.log(`_index: ${(v.regions || []).map((r) => `${r.code}(${r.name})`).join(', ')}`);
            continue;
        }
        console.log(`\n[${d.id}] ${v.name}`);
        for (const c of v.complexes || []) {
            console.log(`   ${c.complexId}  ${c.name.padEnd(20)} ${c.host}`);
        }
    }
}

async function cmdPush(file, dryRun) {
    if (!file) die('올릴 JSON 파일을 지정하세요.', '예: node tools/directory.js push directory.json');
    if (!fs.existsSync(file)) die(`파일이 없습니다: ${file}`);

    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        die(`JSON 을 읽을 수 없습니다: ${err.message}`);
    }

    const problems = validate(doc);
    if (problems.length) {
        console.error('\n올리지 않았습니다. 먼저 고치세요:\n');
        problems.forEach((p) => console.error('  · ' + p));
        process.exit(1);
    }

    const index = doc.regions.map((r) => ({ code: r.code, name: r.name }));
    console.log(`지역 ${doc.regions.length}개, 단지 ${doc.regions.reduce((n, r) => n + r.complexes.length, 0)}개`);
    for (const r of doc.regions) {
        console.log(`  [${r.code}] ${r.name} — ${r.complexes.map((c) => c.name).join(', ')}`);
    }

    if (dryRun) return console.log('\n--dry-run 이라 올리지 않았습니다.');

    const { db } = init();
    // 한 번에 반영한다. 절반만 올라가면 앱이 목록에는 있는데 열 수 없는 단지를 본다.
    const batch = db.batch();
    // updatedAt 은 서버 시각으로 둔다 — 올리는 쪽 시계를 믿지 않는다.
    const now = admin.firestore.FieldValue.serverTimestamp();
    batch.set(db.doc('regions/_index'), { regions: index, updatedAt: now });
    for (const r of doc.regions) {
        batch.set(db.doc(`regions/${r.code}`), {
            name: r.name,
            complexes: r.complexes,
            updatedAt: now,
        });
    }
    await batch.commit();
    console.log('\n올렸습니다.');
}

(async () => {
    const [cmd, arg] = process.argv.slice(2);
    const dryRun = process.argv.includes('--dry-run');
    try {
        if (cmd === 'check') await cmdCheck();
        else if (cmd === 'pull') await cmdPull();
        else if (cmd === 'push') await cmdPush(arg, dryRun);
        else {
            console.log('사용법:');
            console.log('  node tools/directory.js check');
            console.log('  node tools/directory.js pull');
            console.log('  node tools/directory.js push <파일.json> [--dry-run]');
            process.exit(1);
        }
    } catch (err) {
        die(err.message);
    }
    process.exit(0);
})();
