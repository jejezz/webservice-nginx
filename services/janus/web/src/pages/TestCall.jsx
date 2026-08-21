import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Phone, PhoneCall, PhoneIncoming, PhoneOff, Plug, PlugZap, Trash2, UserCheck, Video } from 'lucide-react';
import { InfoCard } from '@/components/InfoCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { initJanus } from '@/lib/janusLib';

/*
 * 시험 클라이언트.
 *
 * 3단계  브라우저 → nginx(/janus-api) → Janus 세션 · SIP 플러그인 attach   ✅
 * 4단계  Kamailio 에 SIP 등록                                              ✅
 * 5단계  실제 통화 (브라우저 ↔ 브라우저)                                   ← 지금
 *
 * 브라우저 ↔ 브라우저를 시험하려면 **탭 둘**을 열어 각각 2001 · 2002 로
 * 등록한 뒤 한쪽에서 다른 쪽으로 겁니다.
 *
 * 비밀번호는 어디에도 저장하지 않습니다. 이 화면에서 Janus 로 바로 넘어가고,
 * Janus 가 Kamailio 에 digest 로 응답합니다. 새로 고치면 다시 입력해야 합니다.
 */

const MAX_LOG = 200;

const REG_LABEL = {
  idle: '등록 안 됨',
  registering: '등록 중…',
  registered: '등록됨',
  failed: '등록 실패',
  unregistering: '해지 중…',
};

export default function TestCall() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [state, setState] = useState('idle'); // idle | connecting | connected | error
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [handleId, setHandleId] = useState(null);
  const [logs, setLogs] = useState([]);

  // 등록 폼
  const [user, setUser] = useState('2001');
  const [secret, setSecret] = useState('');
  const [proxy, setProxy] = useState('');
  const [regState, setRegState] = useState('idle');
  const [regError, setRegError] = useState('');
  const [registeredAs, setRegisteredAs] = useState('');

  // 통화
  const [callState, setCallState] = useState('idle'); // idle|calling|ringing|incoming|incall
  const [peer, setPeer] = useState('2002');
  const [incomingFrom, setIncomingFrom] = useState('');
  const [withVideo, setWithVideo] = useState(false);
  const [callError, setCallError] = useState('');
  const [iceState, setIceState] = useState('');

  const janusRef = useRef(null);
  const handleRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const incomingJsepRef = useRef(null);

  /*
   * janus.js 콜백은 attach 할 때 한 번 등록되고 그대로 붙들립니다. 그 자리에
   * 함수를 직접 넘기면 그때의 state 를 평생 들고 있게 됩니다 (React 의 낡은
   * 클로저). 등록만 할 때는 드러나지 않았지만 통화 상태가 붙으면 바로 문제가
   * 됩니다 — 그래서 ref 를 한 겹 두고 항상 최신 함수를 부릅니다.
   */
  const msgHandlerRef = useRef(null);

  const push = useCallback((level, message) => {
    setLogs((prev) => [
      { at: new Date().toLocaleTimeString('ko-KR', { hour12: false }), level, message },
      ...prev,
    ].slice(0, MAX_LOG));
  }, []);

  useEffect(() => {
    api.testCallConfig()
      .then((cfg) => {
        setConfig(cfg);
        setProxy(cfg.sipProxy || '');
      })
      .catch((err) => setConfigError(err.message));
  }, []);

  // 화면을 떠날 때 세션을 정리한다. 남겨 두면 Janus 쪽에 세션이 쌓인다.
  useEffect(() => () => {
    if (janusRef.current) {
      try { janusRef.current.destroy(); } catch { /* 이미 정리됨 */ }
    }
  }, []);

  /** createOffer/createAnswer 에 넘길 트랙 구성. 음성이 기본이다 (계획서 ⑥). */
  const trackSpec = useCallback(() => {
    const tracks = [{ type: 'audio', capture: true, recv: true }];
    if (withVideo) tracks.push({ type: 'video', capture: true, recv: true });
    return tracks;
  }, [withVideo]);

  const resetCall = useCallback(() => {
    setCallState('idle');
    setIncomingFrom('');
    setCallError('');
    setIceState('');
    incomingJsepRef.current = null;
    remoteStreamRef.current = null;
  }, []);

  /** SIP 플러그인이 보내는 이벤트. 등록과 통화 결과가 모두 여기로 온다. */
  const onPluginMessage = useCallback((msg, jsep) => {
    const result = msg?.result;

    if (msg?.error) {
      // 플러그인 수준 오류. 등록 요청 자체가 형식에 안 맞을 때 등.
      setRegError(`${msg.error_code ?? ''} ${msg.error}`.trim());
      setRegState('failed');
      push('error', `plugin error: ${msg.error_code ?? ''} ${msg.error}`);
      return;
    }
    /*
     * 상대의 SDP.
     *
     * ⚠️ **answer 일 때만** handleRemoteJsep 을 부른다. offer 는 착신
     *    (incomingcall)과 함께 오는데, 그건 createAnswer 에 넘겨야 하는
     *    것이라 여기서 먼저 삼키면 응답을 만들 수 없다.
     *
     *    answer 는 accepted(200 OK)와 progress(183)에 실려 온다. 이걸
     *    빠뜨리면 통화가 "연결됨" 인데 소리가 안 난다.
     */
    if (jsep && handleRef.current) {
      push('info', `SDP ${jsep.type} 수신`);
      if (jsep.type === 'answer') handleRef.current.handleRemoteJsep({ jsep });
    }

    if (!result?.event) {
      push('info', `plugin: ${JSON.stringify(msg)}`);
      return;
    }

    switch (result.event) {
      case 'registering':
        setRegState('registering');
        push('info', 'REGISTER 를 보냈습니다');
        break;
      case 'registered':
        setRegState('registered');
        setRegError('');
        setRegisteredAs(result.username || '');
        push('ok', `등록됨: ${result.username || user}`);
        break;
      case 'registration_failed':
        setRegState('failed');
        setRegError(`${result.code ?? ''} ${result.reason ?? ''}`.trim());
        push('error', `등록 실패: ${result.code ?? ''} ${result.reason ?? ''}`);
        break;
      case 'unregistering':
        setRegState('unregistering');
        push('info', '등록을 해지합니다');
        break;
      case 'unregistered':
        setRegState('idle');
        setRegisteredAs('');
        push('ok', '해지됨');
        break;
      // --- 통화 ---
      case 'calling':
        setCallState('calling');
        push('info', 'INVITE 를 보냈습니다');
        break;
      case 'ringing':
      case 'proceeding':
        setCallState('ringing');
        push('info', `상대가 울리는 중 (${result.event})`);
        break;
      case 'incomingcall':
        incomingJsepRef.current = jsep || null;
        setIncomingFrom(result.username || result.displayname || '(알 수 없음)');
        setCallState('incoming');
        push('ok', `착신: ${result.username || ''}`);
        break;
      case 'progress':
        // 얼리 미디어(183). jsep 이 함께 오면 링백이 들린다.
        push('info', '183 Session Progress');
        break;
      case 'accepted':
        setCallState('incall');
        setCallError('');
        push('ok', '통화 연결됨 (200 OK)');
        break;
      case 'hangup':
        // code/reason 이 왜 끊겼는지 알려 준다. 486 = 통화 중, 480 = 없음 등.
        push(result.code >= 400 && result.code !== 487 ? 'error' : 'info',
          `통화 종료: ${result.code ?? ''} ${result.reason ?? ''}`.trim());
        if (result.code >= 400 && result.code !== 487) {
          setCallError(`${result.code} ${result.reason ?? ''}`.trim());
        }
        /*
         * ⚠️ **PeerConnection 을 여기서 반드시 정리한다.**
         *
         * 상태만 idle 로 되돌리고 넘어갔더니, 다음 통화의 createOffer 가 남아
         * 있던 PeerConnection 을 다시 쓰면서 Janus 가 이렇게 거절했다.
         *
         *     [WARN] Agent already exists?
         *     [ERR]  Error setting ICE locally
         *
         * 첫 통화가 실패한 뒤 다시 거는 것이 아예 막히는 형태라, 원인을 첫
         * 실패 쪽에서 찾게 되어 더 헷갈렸다. janus.js 의 hangup() 이 로컬
         * WebRTC 자원을 정리한다 (SIP 쪽 hangup 요청과는 별개다).
         */
        handleRef.current?.hangup();
        resetCall();
        break;
      case 'declining':
      case 'hangingup':
        push('info', `plugin: ${result.event}`);
        break;
      case 'missed_call':
        push('info', `부재중: ${result.caller ?? ''}`);
        resetCall();
        break;
      default:
        push('info', `plugin: ${result.event}`);
    }
  }, [push, user, resetCall]);

  // 콜백이 항상 최신 함수를 보게 한다 (위 msgHandlerRef 주석 참고).
  msgHandlerRef.current = onPluginMessage;

  const connect = useCallback(async () => {
    if (!config) return;
    setState('connecting');
    setError('');
    push('info', 'janus.js 를 불러옵니다…');

    let Janus;
    try {
      Janus = await initJanus({ debug: false });
      push('ok', 'janus.js 준비됨');
    } catch (err) {
      setError(err.message);
      setState('error');
      push('error', err.message);
      return;
    }

    // 상대 경로를 그대로 넘긴다. 공유기가 외부 28443 → 내부 443 으로 넘기므로
    // 절대 URL 을 만들면 포트가 어긋난다 (nginx 설정의 absolute_redirect off 와
    // 같은 이유).
    //
    // ⚠️ 끝에 슬래시가 붙으면 안 된다. janus.js 는 server + "/" + sessionId 로
    //    주소를 만들어서, 슬래시가 있으면 // 가 된다. nginx 라우트도 슬래시 없는
    //    /janus-api 다 (nginx-conf/service.ini 참고).
    const server = new URL(config.janusPath, window.location.href).toString().replace(/\/+$/, '');
    push('info', `Janus 에 연결합니다: ${server}`);

    janusRef.current = new Janus({
      server,
      apisecret: config.apiSecret || undefined,
      success: () => {
        const sid = janusRef.current.getSessionId();
        setSessionId(sid);
        push('ok', `세션 생성됨 (id ${sid})`);

        janusRef.current.attach({
          plugin: 'janus.plugin.sip',
          success: (pluginHandle) => {
            handleRef.current = pluginHandle;
            setHandleId(pluginHandle.getId());
            setState('connected');
            push('ok', `janus.plugin.sip 에 붙었습니다 (handle ${pluginHandle.getId()})`);
          },
          error: (err) => {
            setError(`플러그인에 붙지 못했습니다: ${err}`);
            setState('error');
            push('error', `attach 실패: ${err}`);
          },
          // 함수를 직접 넘기지 않는다 — 낡은 클로저를 붙들게 된다.
          onmessage: (msg, jsep) => msgHandlerRef.current?.(msg, jsep),

          /*
           * 상대 미디어. Janus 1.x 는 스트림이 아니라 **트랙 단위**로 준다
           * (onremotestream 은 없어졌다). 하나의 MediaStream 에 모아 붙인다.
           */
          onremotetrack: (track, mid, on) => {
            if (!on) {
              remoteStreamRef.current?.removeTrack(track);
              push('info', `상대 ${track.kind} 트랙 제거 (mid ${mid})`);
              return;
            }
            if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
            remoteStreamRef.current.addTrack(track);
            push('ok', `상대 ${track.kind} 트랙 도착 (mid ${mid})`);

            const el = track.kind === 'video' ? remoteVideoRef.current : remoteAudioRef.current;
            if (el && window.Janus) window.Janus.attachMediaStream(el, remoteStreamRef.current);
          },

          // 미디어가 실제로 흐르기 시작했는지. "연결됨인데 무음" 을 가르는 신호다.
          mediaState: (kind, on) => push(on ? 'ok' : 'info', `미디어 ${kind} ${on ? '수신 시작' : '멈춤'}`),
          webrtcState: (up) => push(up ? 'ok' : 'info', `WebRTC ${up ? '연결됨' : '끊김'}`),
          iceState: (st) => { setIceState(st); push('info', `ICE ${st}`); },
          oncleanup: () => { push('info', 'plugin: cleanup'); resetCall(); },
        });
      },
      error: (err) => {
        // 대표적인 원인: Janus 가 안 떠 있음(502), api_secret 불일치(403).
        setError(String(err));
        setState('error');
        push('error', `연결 실패: ${err}`);
      },
      destroyed: () => {
        setState('idle');
        setSessionId(null);
        setHandleId(null);
        setRegState('idle');
        setRegisteredAs('');
        resetCall();
        push('info', '세션이 정리되었습니다');
      },
    });
  }, [config, push, resetCall]);

  const disconnect = useCallback(() => {
    if (janusRef.current) {
      janusRef.current.destroy();
      janusRef.current = null;
      handleRef.current = null;
    }
  }, []);

  const register = useCallback(() => {
    if (!handleRef.current || !config) return;
    setRegError('');
    setRegState('registering');

    /*
     * username 은 SIP URI 다. 도메인은 Kamailio 가 자기 것으로 아는 이름이어야
     * 한다 (kamailio-local.cfg 의 alias). 다르면 Kamailio 가 외부로 릴레이하려
     * 하고 403 Not relaying 이 난다.
     *
     * proxy 는 루프백이 아니라 LAN 주소다. 127.0.0.1 로 붙으면 시그널링은 되는데
     * SDP 에 실리는 주소가 어긋나 소리가 안 난다 (docs/plan.md ③).
     *
     * ⚠️ outbound_proxy 를 빠뜨리면 등록은 되는데 **발신만 조용히 실패한다.**
     *    proxy 는 REGISTER 를 보낼 곳일 뿐이고, INVITE 의 목적지는 요청 URI 의
     *    도메인으로 정해진다. 그런데 pluto.org 는 실재하는 공인 도메인이라
     *    sofia-sip 이 DNS 로 풀어 INVITE 를 인터넷으로 보내 버린다. Kamailio 는
     *    그것을 아예 보지 못하므로 로그도 응답도 없고, 화면에는 'calling' 에서
     *    멈춘 것으로만 보인다. outbound_proxy 가 NUTAG_PROXY 로 들어가 모든
     *    요청을 여기로 보낸다 (janus_sip.c 의 nua_invite 호출).
     */
    handleRef.current.send({
      message: {
        request: 'register',
        username: `sip:${user}@${config.sipDomain}`,
        authuser: user,
        display_name: user,
        secret,
        proxy,
        outbound_proxy: proxy,
      },
    });
    push('info', `register 요청: sip:${user}@${config.sipDomain} → ${proxy}`);
  }, [config, user, secret, proxy, push]);

  const unregister = useCallback(() => {
    if (!handleRef.current) return;
    handleRef.current.send({ message: { request: 'unregister' } });
  }, []);

  const doCall = useCallback(() => {
    if (!handleRef.current || !config) return;
    setCallError('');
    setCallState('calling');

    const uri = peer.includes('@') ? `sip:${peer}` : `sip:${peer}@${config.sipDomain}`;
    push('info', `전화를 겁니다: ${uri}`);

    handleRef.current.createOffer({
      tracks: trackSpec(),
      success: (jsep) => handleRef.current.send({ message: { request: 'call', uri }, jsep }),
      error: (err) => {
        // 대개 마이크 권한 거부다. HTTPS 가 아니면 getUserMedia 자체가 없다.
        setCallError(`미디어를 준비하지 못했습니다: ${err.message || err}`);
        setCallState('idle');
        push('error', `createOffer 실패: ${err.message || err}`);
      },
    });
  }, [config, peer, push, trackSpec]);

  const doAccept = useCallback(() => {
    if (!handleRef.current || !incomingJsepRef.current) return;
    setCallError('');
    push('info', '전화를 받습니다');

    handleRef.current.createAnswer({
      jsep: incomingJsepRef.current,
      tracks: trackSpec(),
      success: (jsep) => handleRef.current.send({ message: { request: 'accept' }, jsep }),
      error: (err) => {
        setCallError(`응답 SDP 를 만들지 못했습니다: ${err.message || err}`);
        push('error', `createAnswer 실패: ${err.message || err}`);
        handleRef.current.send({ message: { request: 'decline' } });
        resetCall();
      },
    });
  }, [push, trackSpec, resetCall]);

  const doDecline = useCallback(() => {
    handleRef.current?.send({ message: { request: 'decline' } });
    resetCall();
  }, [resetCall]);

  const doHangup = useCallback(() => {
    handleRef.current?.send({ message: { request: 'hangup' } });
    handleRef.current?.hangup();
    resetCall();
  }, [resetCall]);

  const connected = state === 'connected';
  const registered = regState === 'registered';

  /*
   * 버튼을 왜 누를 수 없는지 화면에 적는다.
   *
   * 처음에는 그냥 disabled 로만 두었는데, 비밀번호를 넣기 전에는 버튼이 죽어
   * 있고 이유가 어디에도 없어서 "연결은 됐는데 등록 버튼이 안 눌린다" 로만
   * 보였다. 비활성 이유를 말하지 않는 버튼은 고장난 버튼과 구분되지 않는다.
   */
  const missing = [];
  if (!user.trim()) missing.push('계정');
  if (!secret) missing.push('비밀번호');
  if (!proxy.trim()) missing.push('proxy');

  return (
    <div className="space-y-6">
      <Alert>
        <PhoneCall className="size-4" />
        <AlertTitle>브라우저 ↔ 브라우저 시험 통화 (계획서 5단계)</AlertTitle>
        <AlertDescription>
          <strong>탭 둘</strong>을 열어 각각 <span className="font-mono">2001</span> ·
          <span className="font-mono"> 2002</span> 로 등록한 뒤 한쪽에서 다른 쪽으로 겁니다.
          미디어는 <span className="font-mono">브라우저 ↔ Janus ↔ rtpproxy ↔ Janus ↔ 브라우저</span> 로
          흐릅니다. 음성부터 확인하고 영상은 그 다음입니다.
        </AlertDescription>
      </Alert>

      {configError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>설정을 받지 못했습니다</AlertTitle>
          <AlertDescription>{configError}</AlertDescription>
        </Alert>
      )}

      <InfoCard
        title="연결 정보"
        Icon={Plug}
        columns={2}
        rows={[
          ['Janus 경로', config?.janusPath],
          ['api_secret', config?.apiSecret ? '받음 (로그인된 세션)' : '없음'],
          ['SIP 도메인', config?.sipDomain, 'Kamailio 가 자기 것으로 아는 이름 (alias)'],
          ['세션 / 핸들', connected ? `${sessionId} / ${handleId}` : '—'],
        ]}
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <PlugZap className="size-4" />
            1. Janus 연결
          </CardTitle>
          <Badge variant={connected ? 'default' : state === 'error' ? 'destructive' : 'secondary'}>
            {{ idle: '끊김', connecting: '연결 중…', connected: '연결됨', error: '오류' }[state]}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Button onClick={connect} disabled={!config || state === 'connecting' || connected}>
              연결
            </Button>
            <Button variant="outline" onClick={disconnect} disabled={!connected}>
              끊기
            </Button>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>연결하지 못했습니다</AlertTitle>
              <AlertDescription className="space-y-1">
                <p className="font-mono text-xs">{error}</p>
                <p className="text-xs">
                  Janus 가 떠 있는지 <span className="font-mono">./install.sh</span> 로 확인하세요.
                </p>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCheck className="size-4" />
            2. SIP 등록
          </CardTitle>
          <Badge
            variant={registered ? 'default' : regState === 'failed' ? 'destructive' : 'secondary'}
          >
            {REG_LABEL[regState]}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {!connected && (
            <p className="text-xs text-muted-foreground">먼저 Janus 에 연결하세요.</p>
          )}

          <form
            className="grid gap-4 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              register();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="sip-user" className="text-xs">계정</Label>
              <Input
                id="sip-user"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                disabled={!connected || registered}
                autoComplete="username"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sip-secret" className="text-xs">
                비밀번호 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="sip-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                disabled={!connected || registered}
                autoComplete="current-password"
                placeholder="계정의 SIP 비밀번호"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sip-proxy" className="text-xs">proxy</Label>
              <Input
                id="sip-proxy"
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                disabled={!connected || registered}
                className="font-mono"
              />
            </div>
            <div className="sm:col-span-3 flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={!connected || registered || missing.length > 0}>
                등록
              </Button>
              <Button type="button" variant="outline" onClick={unregister} disabled={!registered}>
                해지
              </Button>
              {connected && !registered && missing.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {missing.join(' · ')} 을(를) 채우면 누를 수 있습니다
                </span>
              )}
              {registeredAs && (
                <span className="font-mono text-xs text-muted-foreground">{registeredAs}</span>
              )}
            </div>
          </form>

          {regError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>등록하지 못했습니다</AlertTitle>
              <AlertDescription className="space-y-1">
                <p className="font-mono text-xs">{regError}</p>
                <p className="text-xs">
                  <span className="font-mono">401</span> 이면 계정이 없거나 비밀번호가 다릅니다 —
                  이 서버는 평문 <span className="font-mono">password</span> 컬럼으로 인증하므로,
                  그 값이 비어 있으면 어떤 비밀번호로도 실패합니다
                  (kamailio/accounts.md). <span className="font-mono">403 Not relaying</span> 면
                  SIP 도메인이 Kamailio 의 alias 와 다릅니다.
                </p>
              </AlertDescription>
            </Alert>
          )}

          <p className="text-xs text-muted-foreground">
            비밀번호는 <strong>계정을 만들 때 정한 SIP 비밀번호</strong>입니다
            (manager 로그인 비밀번호가 아닙니다). 어디에도 저장하지 않고 이 화면에서
            Janus 로 바로 넘어가며, Kamailio 에는 Janus 가 digest 로 응답합니다.
            새로 고치면 다시 입력해야 합니다.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Phone className="size-4" />
            3. 통화
          </CardTitle>
          <div className="flex items-center gap-2">
            {iceState && (
              <Badge variant="secondary" className="font-mono text-xs">ICE {iceState}</Badge>
            )}
            <Badge variant={callState === 'incall' ? 'default' : callState === 'idle' ? 'secondary' : 'outline'}>
              {{
                idle: '대기', calling: '거는 중…', ringing: '울리는 중…',
                incoming: '착신!', incall: '통화 중',
              }[callState]}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!registered && (
            <p className="text-xs text-muted-foreground">먼저 SIP 등록을 마치세요.</p>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="peer" className="text-xs">상대</Label>
              <Input
                id="peer"
                value={peer}
                onChange={(e) => setPeer(e.target.value)}
                disabled={!registered || callState !== 'idle'}
                className="w-44 font-mono"
                placeholder="2002"
              />
            </div>

            <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={withVideo}
                onChange={(e) => setWithVideo(e.target.checked)}
                disabled={callState !== 'idle'}
                className="size-3.5"
              />
              <Video className="size-3.5" />
              영상 포함
            </label>

            {callState === 'idle' && (
              <Button onClick={doCall} disabled={!registered || !peer.trim()}>
                <Phone className="size-3.5" />
                전화 걸기
              </Button>
            )}
            {callState === 'incoming' && (
              <>
                <Button onClick={doAccept}>
                  <PhoneIncoming className="size-3.5" />
                  받기
                </Button>
                <Button variant="outline" onClick={doDecline}>거절</Button>
              </>
            )}
            {(callState === 'calling' || callState === 'ringing' || callState === 'incall') && (
              <Button variant="destructive" onClick={doHangup}>
                <PhoneOff className="size-3.5" />
                끊기
              </Button>
            )}
          </div>

          {callState === 'incoming' && (
            <Alert>
              <PhoneIncoming className="size-4" />
              <AlertTitle>걸려 온 전화</AlertTitle>
              <AlertDescription className="font-mono text-xs">{incomingFrom}</AlertDescription>
            </Alert>
          )}

          {callError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>통화가 성립하지 않았습니다</AlertTitle>
              <AlertDescription className="space-y-1">
                <p className="font-mono text-xs">{callError}</p>
                <p className="text-xs">
                  <span className="font-mono">404</span> 상대 계정이 없음 ·
                  <span className="font-mono"> 480</span> 등록돼 있지 않음 ·
                  <span className="font-mono"> 486</span> 통화 중 ·
                  <span className="font-mono"> 488</span> 코덱·미디어 협상 실패.
                  연결은 됐는데 소리만 없으면 아래 로그의 <span className="font-mono">미디어 audio 수신 시작</span> 이
                  떴는지 보세요. 상대가 <strong>다른 단말에서 같은 계정으로 등록</strong>돼 있으면
                  그쪽으로도 함께 울립니다.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {/*
            상대 소리. controls 를 남겨 둔다 — 브라우저 자동재생 정책에 막혔을 때
            사람이 직접 재생할 수 있어야 원인을 가릴 수 있다.
          */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">상대 미디어</p>
            <audio ref={remoteAudioRef} autoPlay playsInline controls className="w-full" />
            {withVideo && (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full max-w-md rounded-md border bg-muted"
              />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-base">로그</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setLogs([])} disabled={!logs.length}>
            <Trash2 className="size-3.5" />
            지우기
          </Button>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-xs text-muted-foreground">아직 없습니다.</p>
          ) : (
            <ul className="space-y-1">
              {logs.map((entry, i) => (
                <li key={`${entry.at}-${i}`} className="flex gap-2 font-mono text-xs">
                  <span className="shrink-0 text-muted-foreground">{entry.at}</span>
                  <span
                    className={
                      { ok: 'text-success', error: 'text-destructive', info: 'text-foreground' }[entry.level]
                    }
                  >
                    {entry.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
