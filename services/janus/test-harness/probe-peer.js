/**
 * 통화가 살아 있는 동안 **rtpproxy** 에 1초마다 물어, 스트림별로 패킷이 실제로
 * 흐르는지 기록한다. 7단계(실단말)에서 "어느 다리가 죽었는가" 를 가르는 도구다.
 *
 * 왜 rtpproxy 인가 — 브라우저의 getStats 는 WebRTC 다리만 본다. 상대 단말이
 * 소리를 안 보내는 것인지, 보내는데 우리 쪽에서 못 넘기는 것인지는 그것만으로
 * 구분되지 않는다. Janus 의 Admin API 도 SIP(평문) 다리의 RTP 수는 내주지
 * 않는다 (`plugin_specific` 에 등록·통화 상태만 있다 — 실측으로 확인).
 *
 * rtpproxy 는 두 다리 사이에 앉아 있으므로 그 수를 그대로 들고 있다.
 * 제어 소켓은 `-s udp:127.0.0.1 7722` 로 이미 열려 있다.
 *
 *   node probe-peer.js --seconds 90
 *
 * 출력 — 스트림 하나가 한 줄이고, 음성과 영상은 call-id 뒤의 `;1` `;2` 로 갈린다.
 *
 *   <call-id>;1  caller 192.168.0.252:19151/…  callee …  stats 538/1310/1848/0
 *
 * 끝나면 스트림별 증가량 요약을 JSON 으로 낸다. **증가량이 0인 스트림이
 * 소리가 안 나는 쪽**이다.
 */
const dgram = require('dgram');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const SECONDS = parseInt(arg('seconds', '90'), 10);
const PORT = parseInt(arg('control-port', '7722'), 10);
const HOST = arg('control-host', '127.0.0.1');
const QUIET = process.argv.includes('--quiet');

let cookie = 1;
function ask(cmd) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { s.close(); } catch { /* 이미 닫힘 */ } resolve(v); };
    s.on('message', (m) => finish(m.toString()));
    s.on('error', () => finish(null));
    s.send(`${cookie++} ${cmd}\n`, PORT, HOST);
    setTimeout(() => finish(null), 1500);
  });
}

/** `I` 응답에서 스트림 줄만 뽑는다. */
function parse(text) {
  const out = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    // 예: C <callid>;1: caller = a/b, callee = c/d, stats = 1/2/3/4, ttl = -1/-1
    const m = line.match(/^(C\s+)?(\S+);(\d+):\s+caller = (\S+),\s+callee = (\S+),\s+stats = (\S+)/);
    if (!m) continue;
    const [, isCtl, callId, media, caller, callee, stats] = m;
    out.push({
      key: `${callId};${media}${isCtl ? ' (rtcp)' : ''}`,
      callId, media: Number(media), rtcp: Boolean(isCtl),
      caller: caller.replace(/,$/, ''), callee: callee.replace(/,$/, ''),
      stats: stats.replace(/,$/, '').split('/').map(Number),
    });
  }
  return out;
}

async function main() {
  const first = new Map();
  const last = new Map();
  let sawAny = false;

  for (let t = 0; t < SECONDS; t++) {
    const text = await ask('I');
    const rows = parse(text);
    if (rows.length) sawAny = true;
    for (const r of rows) {
      if (!first.has(r.key)) {
        first.set(r.key, r);
        if (!QUIET) console.error(`[+${t}s] 새 스트림 ${r.key}  caller=${r.caller}  callee=${r.callee}`);
      }
      last.set(r.key, r);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }

  /*
   * rtpproxy 는 미디어 하나에 줄 둘(RTP·RTCP)을 낸다. 어느 줄이 어느 쪽인지는
   * 앞의 `C` 표시로 갈리는 듯 보이지만 실측에서 포트와 패킷 수가 어긋났다
   * (RTCP 포트인데 RTP 규모의 수가 찍힌다). 그래서 **라벨을 붙이지 않고**
   * 미디어 번호로 묶어 숫자를 그대로 보여 준다 — 판단은 수가 하게 둔다.
   *
   * 음성과 영상은 call-id 뒤의 미디어 번호로 갈린다 (;1 · ;2). 어느 쪽이
   * 음성인지는 SDP 의 m-line 순서와 같다 — 보통 음성이 먼저다.
   */
  const rows = [...last.keys()].map((k) => {
    const a = first.get(k), b = last.get(k);
    const delta = b.stats.map((v, i) => v - (a.stats[i] ?? 0));
    return {
      line: k, media: b.media, caller: b.caller, callee: b.callee,
      statsFirst: a.stats, statsLast: b.stats, delta,
      // RTCP 만 오가도 몇 개는 늘어난다. 미디어가 흘렀다고 보려면 넉넉히 넘어야 한다.
      movedMuch: delta.some((v) => v > 50),
      movedAtAll: delta.some((v) => v > 0),
    };
  });

  const byMedia = {};
  for (const r of rows) {
    const m = String(r.media);
    byMedia[m] = byMedia[m] || { media: r.media, lines: [], flowing: false };
    byMedia[m].lines.push(r);
    if (r.movedMuch) byMedia[m].flowing = true;
  }

  console.log(JSON.stringify({
    sawAnySession: sawAny,
    media: Object.values(byMedia),
    // 미디어 번호 중 실제로 흐르지 않은 것 — 여기가 소리(또는 영상)가 안 나는 쪽이다.
    silentMedia: Object.values(byMedia).filter((m) => !m.flowing).map((m) => m.media),
  }, null, 2));
}

main();
