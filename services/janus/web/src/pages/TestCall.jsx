import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, PhoneCall, Plug, PlugZap, Trash2 } from 'lucide-react';
import { InfoCard } from '@/components/InfoCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { initJanus } from '@/lib/janusLib';

/*
 * 계획서 3단계의 시험 클라이언트.
 *
 * 여기서 확인하는 것은 **브라우저가 Janus 에 붙는가** 하나입니다 (3-5).
 * SIP 등록은 4단계, 실제 통화는 5단계에서 이 화면에 붙입니다.
 *
 * 붙는 경로: 브라우저 → nginx(/janus-api/) → Janus 8088
 * 로그인된 세션에만 api_secret 을 내려주므로, 이 화면을 열 수 있다는 것 자체가
 * 인증을 거쳤다는 뜻입니다 (docs/plan.md ⑤).
 */

const MAX_LOG = 100;

export default function TestCall() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [state, setState] = useState('idle'); // idle | connecting | connected | error
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [handleId, setHandleId] = useState(null);
  const [logs, setLogs] = useState([]);

  const janusRef = useRef(null);
  const handleRef = useRef(null);

  const push = useCallback((level, message) => {
    setLogs((prev) => [
      { at: new Date().toLocaleTimeString('ko-KR', { hour12: false }), level, message },
      ...prev,
    ].slice(0, MAX_LOG));
  }, []);

  useEffect(() => {
    api.testCallConfig().then(setConfig).catch((err) => setConfigError(err.message));
  }, []);

  // 화면을 떠날 때 세션을 정리한다. 남겨 두면 Janus 쪽에 세션이 쌓인다.
  useEffect(() => () => {
    if (janusRef.current) {
      try { janusRef.current.destroy(); } catch { /* 이미 정리됨 */ }
    }
  }, []);

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
    const server = new URL(config.janusPath, window.location.href).toString();
    push('info', `Janus 에 연결합니다: ${server}`);

    janusRef.current = new Janus({
      server,
      apisecret: config.apiSecret || undefined,
      success: () => {
        const sid = janusRef.current.getSessionId();
        setSessionId(sid);
        push('ok', `세션 생성됨 (id ${sid})`);

        // SIP 플러그인에 붙어 본다. 여기까지 되면 4단계(등록)의 준비가 끝난다.
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
          onmessage: (msg) => {
            // 4단계부터 여기서 등록·통화 이벤트를 처리한다.
            push('info', `plugin: ${JSON.stringify(msg)}`);
          },
          oncleanup: () => push('info', 'plugin: cleanup'),
        });
      },
      error: (err) => {
        // 대표적인 원인: Janus 가 안 떠 있음(502), api_secret 불일치(403),
        // nginx 라우트가 아직 enabled = false.
        setError(String(err));
        setState('error');
        push('error', `연결 실패: ${err}`);
      },
      destroyed: () => {
        setState('idle');
        setSessionId(null);
        setHandleId(null);
        push('info', '세션이 정리되었습니다');
      },
    });
  }, [config, push]);

  const disconnect = useCallback(() => {
    if (janusRef.current) {
      janusRef.current.destroy();
      janusRef.current = null;
      handleRef.current = null;
    }
  }, []);

  const connected = state === 'connected';

  return (
    <div className="space-y-6">
      <Alert>
        <PhoneCall className="size-4" />
        <AlertTitle>지금은 연결 확인까지입니다 (계획서 3-5)</AlertTitle>
        <AlertDescription>
          브라우저가 nginx 를 거쳐 Janus 에 붙고 SIP 플러그인 핸들을 얻는 것까지
          확인합니다. SIP 등록은 4단계, 실제 통화는 5단계에서 이 화면에 붙입니다.
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
          ['SIP proxy', config?.sipProxy, '4단계에서 register 에 쓰입니다'],
          ['SIP 도메인', config?.sipDomain],
        ]}
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <PlugZap className="size-4" />
            연결
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
                  Janus 가 떠 있는지(<span className="font-mono">./install.sh</span>),
                  nginx 라우트가 켜져 있는지(<span className="font-mono">nginx-conf/service.ini</span> 의
                  enabled) 확인하세요.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {connected && (
            <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5">
                <dt className="text-xs text-muted-foreground">세션 ID</dt>
                <dd className="font-mono text-xs">{sessionId}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5">
                <dt className="text-xs text-muted-foreground">핸들 ID</dt>
                <dd className="font-mono text-xs">{handleId}</dd>
              </div>
            </dl>
          )}
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
