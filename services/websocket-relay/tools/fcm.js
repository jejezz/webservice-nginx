#!/usr/bin/env node
/**
 * @file tools/fcm.js
 * @brief FCM 이 실제로 나가는지 가른다. **단말 없이도 상당 부분 확인된다.**
 *
 *   node tools/fcm.js check              자격만 (토큰을 받아 본다)
 *   node tools/fcm.js selftest           **단말 없이** 발송 경로 전체를 확인
 *   node tools/fcm.js dry <토큰>         실제로 보내지 않고 토큰만 검증
 *   node tools/fcm.js send <토큰>        진짜 푸시 (단말에 알림이 뜬다)
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 예전 코드는 `successCount` 만 로그에 남겨서, 실패가 "0 messages were sent
 * successfully" 라는 **성공처럼 보이는 문장**으로 14개월간 묻혀 있었다.
 * 여기서는 실패 원인을 코드째로 드러내고 무엇을 고쳐야 하는지까지 적는다.
 *
 * ── 단말 없이 무엇까지 확인되나 ──────────────────────────────────
 * `selftest` 는 **토픽**으로 보낸다. 토픽은 단말 토큰이 없어도 되고, 구독자가
 * 없으면 메시지는 그냥 버려진다. 그래도 구글이 메시지 ID 를 돌려주므로
 * 자격 · API 활성화 · 프로젝트 · 발송 권한이 **전부** 확인된다.
 * 남는 것은 "그 단말의 토큰이 이 프로젝트 것인가" 하나뿐이다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_DIR = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(SERVICE_DIR, '.env') });

const KEY_FILE = path.resolve(
    SERVICE_DIR,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'secrets/firebase-admin.json'
);

/** 구독자가 없는 진단용 토픽. 보낸 메시지는 아무 데도 가지 않는다. */
const SELFTEST_TOPIC = 'diagnostic-selftest';

/** 실패 코드마다 무엇을 고쳐야 하는지. 코드만 보고는 알 수 없다. */
const HINTS = {
    'app/invalid-credential':
        '서비스 계정이 없거나 키가 폐기됐습니다. 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성',
    'messaging/registration-token-not-registered':
        '그 단말이 앱을 지웠거나 다시 깔았습니다. 재등록하면 새 토큰이 들어옵니다.',
    'messaging/invalid-registration-token':
        '토큰 형식이 잘못됐습니다. 앱이 보낸 값이 잘렸는지 확인하세요.',
    'messaging/invalid-argument':
        '토큰이 이 프로젝트 것이 아니거나 메시지가 잘못됐습니다. 앱의 google-services.json 의 project_id 가 이 키와 같은지 보세요.',
    'messaging/mismatched-credential':
        '토큰이 **다른 프로젝트**에서 발급됐습니다. 앱의 google-services.json 을 이 프로젝트 것으로 바꾸고 재빌드하세요.',
    'messaging/third-party-auth-error':
        'APNs(iOS) 설정 문제입니다. 안드로이드만 쓴다면 이 오류는 나오지 않아야 합니다.',
};

function hintFor(code) {
    return HINTS[code] || null;
}

function loadKey() {
    if (!fs.existsSync(KEY_FILE)) {
        console.error(`\n오류: 서비스 계정 키가 없습니다: ${KEY_FILE}`);
        process.exit(1);
    }
    const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(key) });
    return key;
}

function describe(key) {
    console.log(`프로젝트   ${key.project_id}`);
    console.log(`서비스계정 ${key.client_email}`);
    console.log(`키 ID      ${key.private_key_id}\n`);
}

function baseMessage(extra) {
    return {
        notification: { title: 'FCM 점검', body: '이 알림이 보이면 발송 경로가 정상입니다.' },
        data: { method: 'diagnostic', at: String(Math.floor(Date.now() / 1000)) },
        android: { priority: 'high' },
        ...extra,
    };
}

function reportError(err) {
    const code = err?.errorInfo?.code || err?.code || 'unknown';
    console.log(`  ❌ ${code}`);
    if (err?.message) console.log(`     ${err.message.split('\n')[0]}`);
    const hint = hintFor(code);
    if (hint) console.log(`\n  → ${hint}`);
    return code;
}

async function cmdCheck() {
    const key = loadKey();
    describe(key);
    try {
        await admin.credential.cert(key).getAccessToken();
        console.log('  ✅ 자격 정상 — 액세스 토큰을 받았습니다.');
    } catch (err) {
        reportError(err);
        process.exit(1);
    }
}

async function cmdSelftest() {
    const key = loadKey();
    describe(key);
    console.log(`구독자가 없는 토픽("${SELFTEST_TOPIC}")으로 보냅니다.`);
    console.log('단말이 없어도 되고, 아무에게도 도착하지 않습니다.\n');
    try {
        const id = await admin.messaging().send(baseMessage({ topic: SELFTEST_TOPIC }));
        console.log(`  ✅ 발송 성공 — ${id}`);
        console.log('\n  자격 · FCM API · 프로젝트 · 발송 권한이 모두 정상입니다.');
        console.log('  남은 변수는 "그 단말의 토큰이 이 프로젝트 것인가" 하나뿐입니다.');
        console.log(`  단말이 준비되면:  node tools/fcm.js dry <토큰>`);
    } catch (err) {
        reportError(err);
        process.exit(1);
    }
}

async function cmdSend(token, dryRun) {
    if (!token) {
        console.error('토큰을 지정하세요.  node tools/fcm.js dry <토큰>');
        process.exit(1);
    }
    const key = loadKey();
    describe(key);
    console.log(dryRun
        ? '검증만 합니다 (validate_only) — 단말에 알림이 뜨지 않습니다.\n'
        : '실제로 보냅니다 — 단말에 알림이 뜹니다.\n');
    try {
        const id = await admin.messaging().send(baseMessage({ token }), dryRun);
        console.log(`  ✅ ${dryRun ? '토큰 유효' : '발송 성공'} — ${id}`);
    } catch (err) {
        reportError(err);
        process.exit(1);
    }
}

(async () => {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === 'check') await cmdCheck();
    else if (cmd === 'selftest') await cmdSelftest();
    else if (cmd === 'dry') await cmdSend(arg, true);
    else if (cmd === 'send') await cmdSend(arg, false);
    else {
        console.log('사용법:');
        console.log('  node tools/fcm.js check           자격만');
        console.log('  node tools/fcm.js selftest        단말 없이 발송 경로 확인');
        console.log('  node tools/fcm.js dry <토큰>      보내지 않고 토큰만 검증');
        console.log('  node tools/fcm.js send <토큰>     진짜 푸시');
        process.exit(1);
    }
    process.exit(0);
})();
