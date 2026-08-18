#!/usr/bin/env node
/**
 * 관리자 계정 관리 CLI.
 *
 *   npm run admin -- list
 *   npm run admin -- approve <email>
 *   npm run admin -- revoke  <email>
 *   npm run admin -- add     <email> [--password <pw>] [--name <이름>] [--pending]
 *   npm run admin -- passwd  <email> --password <pw>
 *   npm run admin -- delete  <email>
 *
 * 비밀번호를 주지 않으면 임의로 만들어 한 번만 출력한다.
 */
const crypto = require('crypto');
const db = require('../src/db');
const { DbUserStore } = require('../src/auth/db-user-store');

const store = new DbUserStore();
const ACTOR = `cli:${process.env.SUDO_USER || process.env.USER || 'unknown'}`;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function usage(code = 1) {
  console.log(`사용법:
  npm run admin -- list
  npm run admin -- approve <email>
  npm run admin -- revoke  <email>
  npm run admin -- add     <email> [--password <pw>] [--name <이름>] [--pending]
  npm run admin -- passwd  <email> --password <pw>
  npm run admin -- delete  <email>`);
  process.exit(code);
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const name = args[i].slice(2);
      if (name === 'pending') flags.pending = true;
      else {
        flags[name] = args[i + 1];
        i += 1;
      }
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

function requireEmail(email) {
  if (!email) usage();
  const normalized = String(email).trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    console.error(`이메일 형식이 아닙니다: ${email}`);
    process.exit(1);
  }
  return normalized;
}

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function fmt(value) {
  return value === null || value === undefined ? '-' : String(value);
}

async function cmdList() {
  const rows = await store.list();

  if (rows.length === 0) {
    console.log('등록된 관리자가 없습니다.');
    console.log('로그인 화면에서 이메일로 한 번 시도하면 승인 요청이 만들어집니다.');
    console.log('또는: npm run admin -- add <email>');
    return;
  }

  const pending = rows.filter((r) => !r.approved).length;
  console.log(`총 ${rows.length}명 (승인 대기 ${pending}명)\n`);
  console.log(
    `${'상태'.padEnd(6)} ${'이메일'.padEnd(32)} ${'이름'.padEnd(14)} ${'요청'.padEnd(20)} ${'마지막 로그인'.padEnd(20)} 횟수`
  );
  console.log('-'.repeat(104));

  for (const r of rows) {
    console.log(
      `${(r.approved ? '승인' : '대기').padEnd(6)} ${fmt(r.email).padEnd(32)} ` +
        `${fmt(r.display_name).padEnd(14)} ${fmt(r.requested_at).padEnd(20)} ` +
        `${fmt(r.last_login_at).padEnd(20)} ${r.login_count}`
    );
  }

  if (pending > 0) {
    console.log(`\n승인하려면: npm run admin -- approve <email>`);
  }
}

async function cmdApprove(email) {
  const target = requireEmail(email);
  if (await store.setApproved(target, true, ACTOR)) {
    console.log(`승인 완료: ${target}`);
  } else {
    console.error(`해당 계정을 찾을 수 없습니다: ${target}`);
    process.exitCode = 1;
  }
}

async function cmdRevoke(email) {
  const target = requireEmail(email);
  if (await store.setApproved(target, false, ACTOR)) {
    console.log(`승인 취소: ${target} (이후 로그인 불가)`);
  } else {
    console.error(`해당 계정을 찾을 수 없습니다: ${target}`);
    process.exitCode = 1;
  }
}

async function cmdAdd(email, flags) {
  const target = requireEmail(email);

  if (await store.findByEmail(target)) {
    console.error(`이미 등록된 계정입니다: ${target}`);
    console.error('비밀번호를 바꾸려면: npm run admin -- passwd <email> --password <pw>');
    process.exitCode = 1;
    return;
  }

  const generated = !flags.password;
  const plainPassword = flags.password || generatePassword();

  await store.create({
    email: target,
    plainPassword,
    displayName: flags.name,
    approved: !flags.pending,
    actor: ACTOR,
  });

  console.log(`생성 완료: ${target} (${flags.pending ? '승인 대기' : '승인됨'})`);
  if (generated) {
    console.log(`비밀번호: ${plainPassword}`);
    console.log('이 값은 다시 볼 수 없습니다. 지금 안전한 곳에 옮겨 두세요.');
  }
}

async function cmdPasswd(email, flags) {
  const target = requireEmail(email);
  if (!flags.password) {
    console.error('--password <pw> 가 필요합니다.');
    process.exit(1);
  }

  if (await store.setPassword(target, flags.password, ACTOR)) {
    console.log(`비밀번호 변경: ${target}`);
  } else {
    console.error(`해당 계정을 찾을 수 없습니다: ${target}`);
    process.exitCode = 1;
  }
}

async function cmdDelete(email) {
  const target = requireEmail(email);

  // 마지막 승인 계정을 지우면 아무도 로그인할 수 없게 된다.
  const row = await store.findByEmail(target);
  if (row?.approved && (await store.countApproved()) <= 1) {
    console.error('마지막으로 남은 승인 계정입니다. 삭제하면 로그인할 수 없게 되므로 중단합니다.');
    console.error('다른 계정을 먼저 승인하세요.');
    process.exit(1);
  }

  if (await store.remove(target, ACTOR)) {
    console.log(`삭제 완료: ${target}`);
  } else {
    console.error(`해당 계정을 찾을 수 없습니다: ${target}`);
    process.exitCode = 1;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  const { flags, rest } = parseFlags(args);
  const [email] = rest;

  switch (command) {
    case 'list':    await cmdList(); break;
    case 'approve': await cmdApprove(email); break;
    case 'revoke':  await cmdRevoke(email); break;
    case 'add':     await cmdAdd(email, flags); break;
    case 'passwd':  await cmdPasswd(email, flags); break;
    case 'delete':  await cmdDelete(email); break;
    default:        usage();
  }
}

main()
  .catch((err) => {
    console.error(`오류: ${err.code || ''} ${err.message}`);
    if (err.code === 'ECONNREFUSED' || err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('데이터베이스 접속을 확인하세요. (services/manager/config.json 의 database 항목)');
    }
    process.exitCode = 1;
  })
  .finally(() => db.close());
