/**
 * 동/호 표기. 서버의 src/libs/address.ts 와 같은 규칙이다.
 *
 * 화면에서만 쓰는 표시용 변환이라 서버 코드를 그대로 가져오지 않고 필요한
 * 만큼만 둔다. 형식이 바뀌면 두 곳을 함께 고쳐야 한다.
 */
const ADDRESS_RE = /^([A-Za-z0-9-]{1,8})B([A-Za-z0-9-]{1,8})U$/;

/** `1B101U` → `{ building, unit }`. 형식이 아니면 null. */
export function parseAddress(address) {
  const m = ADDRESS_RE.exec(String(address ?? '').trim().toUpperCase());
  return m ? { building: m[1], unit: m[2] } : null;
}

/** `1B101U` → `1동 101호`. 형식이 아니면 원문 그대로. */
export function toKorean(address) {
  const p = parseAddress(address);
  return p ? `${p.building}동 ${p.unit}호` : (address || '—');
}
