import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Plug, PlugZap, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

/**
 * WebSocket 연결 테스트.
 *
 * 통합 전 무번들 대시보드에만 있던 화면이다. 이쪽에는 `/tests` 의
 * echo_client.html 이 있었지만 `/relay/iot` 이 하드코딩되어 있어 RTC 경로를
 * 확인할 수 없었다.
 *
 * ── 왜 브라우저에서 붙는가 ───────────────────────────────────────
 * **이 화면이 열린 주소를 기준으로** 접속한다. nginx 를 통해 열었다면
 * `/relay/rtc` 가 실제로 프록시되는지까지 한 번에 확인된다 — 서버에서
 * 127.0.0.1:28099 로 직접 찔러 보는 것으로는 알 수 없는 부분이다.
 * (nginx 의 `= /relay/rtc` 라우트와 `timeout 86400` 이 빠지면 통화 중에 끊긴다)
 */

/** 대시보드 주소(`/relay/dashboard/`)에서 릴레이 접두사(`/relay`)를 얻는다. */
const RELAY_BASE = import.meta.env.BASE_URL.replace(/\/+$/, '').replace(/\/[^/]*$/, '');

const PATHS = [
  { value: '/rtc', label: '/rtc — RTC 시그널링' },
  { value: '/iot', label: '/iot — 홈넷 IoT' },
];

/** 서버가 실제로 받는 모양. websocketService.ts 의 핸들러와 같은 필드다. */
const SAMPLE = JSON.stringify(
  {
    method: 'invite',
    sender: 'rtc:test@local',
    receiver: 'rtc:101-1001@local',
    roomid: '0',
    clientid: '0',
    code: '',
    device: 'test',
    extendParam: '',
  },
  null,
  2,
);

function wsUrlFor(path) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${RELAY_BASE}${path}`;
}

export default function Tester() {
  const [path, setPath] = useState('/rtc');
  const [message, setMessage] = useState(SAMPLE);
  const [log, setLog] = useState([]);
  const [state, setState] = useState('closed'); // closed | connecting | open
  const socketRef = useRef(null);
  const logRef = useRef(null);

  const append = useCallback((kind, text) => {
    setLog((prev) => [
      ...prev.slice(-199), // 오래된 줄은 버린다. ICE candidate 가 쏟아지면 금방 수백 줄이 된다.
      { at: new Date().toLocaleTimeString('ko-KR', { hour12: false }), kind, text },
    ]);
  }, []);

  // 화면을 떠날 때 소켓을 반드시 닫는다. 열어 둔 채 나가면 서버 쪽 방에
  // 유령 클라이언트가 남아 ping 주기(60초)가 지나야 정리된다.
  useEffect(() => () => socketRef.current?.close(), []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  function connect() {
    const url = wsUrlFor(path);
    append('info', `연결 시도: ${url}`);
    setState('connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      append('error', `만들 수 없습니다: ${err.message}`);
      setState('closed');
      return;
    }
    socketRef.current = ws;

    ws.onopen = () => { setState('open'); append('info', '연결됨'); };
    ws.onmessage = (e) => append('recv', e.data);
    // 브라우저는 보안상 실패 이유를 알려주지 않는다. onclose 의 code 가 단서다.
    ws.onerror = () => append('error', '오류 (자세한 이유는 브라우저가 알려주지 않습니다)');
    ws.onclose = (e) => {
      setState('closed');
      socketRef.current = null;
      // 1008 은 서버가 경로를 모른다는 뜻이다 (websocketService.ts 의 'unknown path').
      const hint = e.code === 1008 ? ' — 서버가 이 경로를 받지 않습니다' : '';
      append('info', `닫힘 (code=${e.code}${e.reason ? `, ${e.reason}` : ''})${hint}`);
    };
  }

  function send() {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      // 보내기 전에 JSON 으로 읽어 본다. 서버는 파싱에 실패하면 조용히
      // 연결만 끊으므로, 여기서 걸러 주는 편이 원인을 찾기 쉽다.
      JSON.parse(message);
    } catch (err) {
      append('error', `JSON 이 아닙니다: ${err.message}`);
      return;
    }
    ws.send(message);
    append('sent', message);
  }

  const connected = state === 'open';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">연결 테스트</h2>
          <p className="text-xs text-muted-foreground">
            이 화면이 열린 주소로 접속하므로, nginx 를 통해 열었다면 프록시 경로까지 함께 확인됩니다.
          </p>
        </div>
        <Badge variant={connected ? 'default' : state === 'connecting' ? 'outline' : 'secondary'}>
          {connected ? '연결됨' : state === 'connecting' ? '연결 중…' : '끊김'}
        </Badge>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="t-path">경로</Label>
              <select
                id="t-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                disabled={state !== 'closed'}
                className="h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs disabled:opacity-50"
              >
                {PATHS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>

            <code className="flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 text-xs">
              {wsUrlFor(path)}
            </code>

            {connected ? (
              <Button variant="outline" onClick={() => socketRef.current?.close()}>
                <PlugZap className="size-4" /> 끊기
              </Button>
            ) : (
              <Button onClick={connect} disabled={state === 'connecting'}>
                <Plug className="size-4" /> 연결
              </Button>
            )}
            <Button variant="ghost" onClick={() => setLog([])}>
              <Eraser className="size-4" /> 지우기
            </Button>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="t-message">보낼 메시지 (JSON)</Label>
            <textarea
              id="t-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={9}
              className="w-full rounded-md border bg-transparent p-3 font-mono text-xs shadow-xs"
            />
            <div>
              <Button size="sm" onClick={send} disabled={!connected}>
                <Send className="size-4" /> 보내기
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div ref={logRef} className="max-h-80 overflow-y-auto p-3 font-mono text-xs">
            {log.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">아직 주고받은 것이 없습니다.</p>
            ) : (
              log.map((line, i) => (
                <div key={i} className="flex gap-2 border-b py-1 last:border-0">
                  <span className="shrink-0 text-muted-foreground">{line.at}</span>
                  <span
                    className={
                      line.kind === 'error' ? 'shrink-0 text-destructive'
                        : line.kind === 'sent' ? 'shrink-0 text-primary'
                        : line.kind === 'recv' ? 'shrink-0'
                        : 'shrink-0 text-muted-foreground'
                    }
                  >
                    {line.kind === 'sent' ? '→' : line.kind === 'recv' ? '←' : line.kind === 'error' ? '✗' : '·'}
                  </span>
                  <span className="whitespace-pre-wrap break-all">{line.text}</span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
