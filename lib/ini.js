/**
 * 절(section)이 있는 ini 파서 — 이 저장소의 선언 파일들이 쓰는 형식.
 *
 *     [route:ws]
 *     location = /janus-ws
 *     port     = 8188
 *
 * `#` 와 `;` 둘 다 주석입니다. 값에 따옴표를 쓰지 않습니다.
 *
 * ── 왜 공용으로 두는가 ──────────────────────────────────────────────────
 *
 * 같은 파일을 읽는 곳이 셋입니다 — nginx 생성기(파이썬), manager 대시보드,
 * 그리고 janus 대시보드. 파이썬 쪽은 표준 configparser 를 쓰지만 node 쪽이
 * 각자 파서를 들면 언젠가 어긋납니다. lib/settings.js 를 한 곳에 모은 것과
 * 같은 이유입니다.
 *
 * 스키마는 docs/nginx-conf.md 에 있습니다.
 */

function parseIni(text) {
  const sections = {};
  const order = [];
  let current = null;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      if (!sections[current]) {
        sections[current] = {};
        order.push(current);
      }
      continue;
    }

    const kvMatch = line.match(/^([^=]+)=(.*)$/);
    if (kvMatch && current) {
      sections[current][kvMatch[1].trim()] = kvMatch[2].trim();
    }
  }

  return { sections, order };
}

const isTrue = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
const isFalse = (v) => ['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());

module.exports = { parseIni, isTrue, isFalse };
