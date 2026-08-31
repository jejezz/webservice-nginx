#!/usr/bin/env node
// config.json 의 "passwordHash" 에 넣을 값을 만든다.
//
//   printf '%s' '<비밀번호>' | node tools/hash-password.js --stdin   ← 권장
//   npm run hash-password -- '<비밀번호>'
//
// --stdin 을 쓰는 편이 안전하다. 인자로 주면 그 비밀번호가 같은 장비의 다른
// 사용자에게 `ps` 목록으로 그대로 보이고, 셸 히스토리에도 남는다.
const fs = require('fs');
const { hash } = require('../src/auth/password');

const arg = process.argv[2];
let plain;

if (arg === '--stdin' || arg === '-') {
  try {
    // 마지막 줄바꿈 하나만 떼어 낸다. 비밀번호에 공백이 들어갈 수 있으므로
    // trim() 을 쓰지 않는다.
    plain = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    console.error(`표준 입력을 읽지 못했습니다: ${err.message}`);
    process.exit(1);
  }
} else {
  plain = arg;
}

if (!plain) {
  console.error("Usage: printf '%s' '<password>' | node tools/hash-password.js --stdin");
  console.error('       node tools/hash-password.js <password>');
  process.exit(1);
}

console.log(hash(plain));
