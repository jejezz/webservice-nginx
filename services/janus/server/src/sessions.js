/**
 * Admin API 로 세션·핸들·미디어를 읽어 화면이 쓸 모양으로 줄인다 (계획서 8-2~8-4).
 *
 * kamailio-dashboard 와 같은 자세다 — **읽기만 한다.** 세션을 끊거나 설정을
 * 바꾸는 길은 만들지 않는다. 그건 install.sh 가 sudo 로 하는 일이다.
 *
 * ── 필드 이름은 짐작하지 않고 실측했다 ──────────────────────────────
 * 통화가 살아 있는 동안 handle_info 를 그대로 떠서 확인한 구조다.
 *
 *   info.plugin_specific   identity · registration_status · call_status · callee
 *                          (SIP 플러그인. **RTP 수는 여기 없다** — 아래 참고)
 *   info.webrtc.ice        state · selected-pair
 *   info.webrtc.dtls       dtls-state · dtls-role · srtp-profile
 *   info.webrtc.media[N]   type · codecs · direction · stats.in/out · rtcp.main
 *
 * ⚠️ webrtc 절은 **PeerConnection 이 올라와 있을 때만** 생긴다. 등록만 하고
 *    통화 중이 아닌 핸들에는 없다. 없다고 오류가 아니다.
 *
 * ⚠️ 여기서 보이는 RTP 수는 **WebRTC 다리**의 것이다. 상대(SIP) 쪽으로 얼마나
 *    나갔는지는 Janus 가 Admin API 로 내주지 않는다. 그쪽이 궁금하면 rtpproxy
 *    제어 소켓을 봐야 한다 (test-harness/probe-peer.js).
 */
const janus = require('./janus');

/** 세션이 많아도 화면이 죽지 않게 상한을 둔다. handle_info 는 세션당 여러 번이다. */
const MAX_SESSIONS = 50;
const MAX_HANDLES_PER_SESSION = 20;

/** 미디어 한 줄 — 화면이 그리는 데 필요한 것만. */
function shrinkMedia(m) {
  const inS = m.stats?.in || {};
  const outS = m.stats?.out || {};
  const rtcp = m.rtcp?.main || {};
  return {
    mid: m.mid,
    type: m.type,
    codec: m.codecs?.codec || null,
    payloadType: m.codecs?.pt ?? null,
    direction: m.direction || null,
    ssrc: m.ssrc?.ssrc ?? null,
    ssrcPeer: m.ssrc?.['ssrc-peer'] ?? null,
    in: { packets: inS.packets ?? 0, bytes: inS.bytes ?? 0, bytesLastSec: inS.bytes_lastsec ?? 0 },
    out: { packets: outS.packets ?? 0, bytes: outS.bytes ?? 0, bytesLastSec: outS.bytes_lastsec ?? 0, nacks: outS.nacks ?? 0 },
    quality: {
      lost: rtcp.lost ?? null,
      lostByRemote: rtcp['lost-by-remote'] ?? null,
      jitterLocal: rtcp['jitter-local'] ?? null,
      jitterRemote: rtcp['jitter-remote'] ?? null,
      rtt: rtcp.rtt ?? null,
      inLinkQuality: rtcp['in-link-quality'] ?? null,
      outLinkQuality: rtcp['out-link-quality'] ?? null,
    },
  };
}

function shrinkHandle(sessionId, handleId, info) {
  const ps = info?.plugin_specific || {};
  const w = info?.webrtc || null;
  const mediaMap = w?.media || {};

  return {
    sessionId: String(sessionId),
    handleId: String(handleId),
    plugin: info?.plugin || null,
    createdUs: info?.created ?? null,
    // ── 8-3 SIP ──────────────────────────────────────────────────────
    sip: info?.plugin === 'janus.plugin.sip' ? {
      identity: ps.identity || null,
      username: ps.username || null,
      registrationStatus: ps.registration_status || null,
      callStatus: ps.call_status || null,
      callee: ps.callee || null,
      caller: ps.caller || null,
      srtpRequired: ps['srtp-required'] || null,
      established: Boolean(ps.established),
    } : null,
    // ── 8-4 미디어 ───────────────────────────────────────────────────
    webrtc: w ? {
      ice: {
        state: w.ice?.state || null,
        selectedPair: w.ice?.['selected-pair'] || null,
        ready: Boolean(w.ice?.ready),
      },
      dtls: {
        state: w.dtls?.['dtls-state'] || null,
        role: w.dtls?.['dtls-role'] || null,
        srtpProfile: w.dtls?.['srtp-profile'] || null,
        valid: Boolean(w.dtls?.valid),
      },
      media: Object.values(mediaMap).map(shrinkMedia),
    } : null,
    flags: info?.flags ? {
      negotiated: Boolean(info.flags.negotiated),
      hasAudio: Boolean(info.flags['has-audio']),
      hasVideo: Boolean(info.flags['has-video']),
      alert: Boolean(info.flags.alert),
    } : null,
  };
}

/**
 * 세션 → 핸들 → handle_info 를 훑는다.
 *
 * 호출 수가 (세션 수 × 핸들 수)로 늘어나므로 상한을 두고, 하나가 실패해도
 * 나머지는 그대로 낸다. Janus 가 통화 도중에 핸들을 정리하면 handle_info 가
 * 실패할 수 있는데 그것은 오류가 아니라 정상적인 경합이다.
 */
async function snapshot() {
  const list = await janus.admin('list_sessions');
  if (!list.ok) return { ok: false, error: list.error, sessions: [] };

  const ids = (list.data.sessions || []).slice(0, MAX_SESSIONS);
  const truncatedSessions = (list.data.sessions || []).length - ids.length;

  const sessions = await Promise.all(ids.map(async (sid) => {
    const hs = await janus.admin('list_handles', { session_id: sid });
    if (!hs.ok) return { id: String(sid), error: hs.error, handles: [] };

    const hids = (hs.data.handles || []).slice(0, MAX_HANDLES_PER_SESSION);
    const handles = await Promise.all(hids.map(async (hid) => {
      const info = await janus.admin('handle_info', { session_id: sid, handle_id: hid });
      if (!info.ok) return { sessionId: String(sid), handleId: String(hid), error: info.error };
      return shrinkHandle(sid, hid, info.data.info);
    }));

    return {
      id: String(sid),
      handles,
      truncatedHandles: Math.max(0, (hs.data.handles || []).length - hids.length),
    };
  }));

  const allHandles = sessions.flatMap((s) => s.handles);
  return {
    ok: true,
    truncatedSessions: Math.max(0, truncatedSessions),
    counts: {
      sessions: sessions.length,
      handles: allHandles.length,
      registered: allHandles.filter((h) => h.sip?.registrationStatus === 'registered').length,
      inCall: allHandles.filter((h) => h.sip?.callStatus && h.sip.callStatus !== 'idle').length,
    },
    sessions,
  };
}

module.exports = { snapshot };
