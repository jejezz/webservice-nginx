'use strict';

const os = require('os');

/**
 * 이 대시보드가 돌고 있는 장비를 식별하는 정보.
 *
 * 로그인 화면에 띄우기 위한 것이다 — 서버가 여러 대일 때 "지금 어느 장비에
 * 로그인하는 중인지" 를 로그인 전에 알 수 있어야 한다.
 *
 * IP 는 마지막 옥텟만 보여 준다 (x.x.x.224). 인증 전에 응답하는 값이라
 * 내부망 구조를 통째로 드러낼 이유가 없고, 장비를 구분하는 데는 마지막
 * 자리만으로 충분하다.
 */

/** 외부와 통신하는 IPv4 주소. 없으면 null. */
function primaryIPv4() {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      // family 는 Node 18+ 에서 숫자 4, 그 이전에는 문자열 'IPv4' 다.
      const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
      if (isIPv4 && !iface.internal) return iface.address;
    }
  }

  return null;
}

/** 10.10.0.224 -> x.x.x.224 */
function maskIPv4(address) {
  if (!address) return null;
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  return `x.x.x.${parts[3]}`;
}

/**
 * @returns {{hostname: string, address: string|null}}
 *   address 는 마스킹된 형태이거나, IPv4 를 찾지 못하면 null.
 */
function identity() {
  return {
    hostname: os.hostname(),
    address: maskIPv4(primaryIPv4()),
  };
}

module.exports = { identity, primaryIPv4, maskIPv4 };
