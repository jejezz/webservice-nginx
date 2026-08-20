import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, PhoneCall, Plug, PlugZap, Trash2, UserCheck } from 'lucide-react';
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
 * 4단계  Kamailio 에 SIP 등록                                              ← 지금
 * 5단계  실제 통화 (브라우저 ↔ 브라우저)                                   다음
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

  const janusRef = useRef(null);
  const handleRef = useRef(null);

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

  /** SIP 플러그인이 보내는 이벤트. 등록 결과가 여기로 온다. */
  const onPluginMessage = useCallback((msg) => {
    const result = msg?.result;

    if (msg?.error) {
      // 플러그인 수준 오류. 등록 요청 자체가 형식에 안 맞을 때 등.
      setRegError(`${msg.error_code ?? ''} ${msg.error}`.trim());
      setRegState('failed');
      push('error', `plugin error: ${msg.error_code ?? ''} ${msg.error}`);
      return;
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
      default:
        // incomingcall · accepted · hangup 등은 5단계에서 다룬다.
        push('info', `plugin: ${result.event}`);
    }
  }, [push, user]);

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
          onmessage: onPluginMessage,
          oncleanup: () => push('info', 'plugin: cleanup'),
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
        push('info', '세션이 정리되었습니다');
      },
    });
  }, [config, push, onPluginMessage]);

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
     */
    handleRef.current.send({
      message: {
        request: 'register',
        username: `sip:${user}@${config.sipDomain}`,
        authuser: user,
        display_name: user,
        secret,
        proxy,
      },
    });
    push('info', `register 요청: sip:${user}@${config.sipDomain} → ${proxy}`);
  }, [config, user, secret, proxy, push]);

  const unregister = useCallback(() => {
    if (!handleRef.current) return;
    handleRef.current.send({ message: { request: 'unregister' } });
  }, []);

  const connected = state === 'connected';
  const registered = regState === 'registered';

  return (
    <div className="space-y-6">
      <Alert>
        <PhoneCall className="size-4" />
        <AlertTitle>지금은 SIP 등록까지입니다 (계획서 4단계)</AlertTitle>
        <AlertDescription>
          브라우저가 Janus 를 거쳐 Kamailio 에 REGISTER 하는 것까지 확인합니다.
          실제 통화(발신·착신)는 5단계에서 이 화면에 붙입니다.
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
              <Label htmlFor="sip-secret" className="text-xs">비밀번호</Label>
              <Input
                id="sip-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                disabled={!connected || registered}
                autoComplete="current-password"
                placeholder="저장하지 않습니다"
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
            <div className="sm:col-span-3 flex items-center gap-2">
              <Button type="submit" disabled={!connected || registered || !user || !secret || !proxy}>
                등록
              </Button>
              <Button type="button" variant="outline" onClick={unregister} disabled={!registered}>
                해지
              </Button>
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
            비밀번호는 저장하지 않습니다. 이 화면에서 Janus 로 바로 넘어가고,
            Kamailio 에는 Janus 가 digest 로 응답합니다.
          </p>
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
