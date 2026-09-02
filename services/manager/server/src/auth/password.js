const crypto = require('crypto');

const SCRYPT_KEYLEN = 32;

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // 길이가 달라도 비교 시간을 일정하게 유지한다.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// 형식: scrypt$<saltHex>$<hashHex>
function hash(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyHash(plain, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;

  const derived = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hash, verifyHash, timingSafeEqualStr };
