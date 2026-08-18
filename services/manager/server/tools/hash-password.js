#!/usr/bin/env node
// config.json의 "passwordHash"에 넣을 값을 생성한다.
//   npm run hash-password -- 'mypassword'
const { hash } = require('../src/auth/password');

const plain = process.argv[2];

if (!plain) {
  console.error('Usage: node tools/hash-password.js <password>');
  process.exit(1);
}

console.log(hash(plain));
