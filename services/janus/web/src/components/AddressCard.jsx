import { useState } from 'react';
import { Check, Copy, Link2, Loader2, Plug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * 접속 주소 — 클라이언트가 어디로 붙는가.
 *
 * 주소는 `nginx-conf/*.ini` 에서 옵니다 (nginx 생성기가 읽는 같은 파일).
 * 화면에 따로 적어 두면 언젠가 실제 라우팅과 어긋납니다.
 *
 * **오리진은 브라우저가 붙입니다.** 이 대시보드가 같은 nginx 뒤에 있으므로,
 * 지금 이 페이지를 연 주소가 곧 밖에서 쓸 주소입니다.
 */

function externalUrl(entry) {
  if (!entry.external) return null;
  const { protocol, host } = window.location;
  const secure = protocol === 'https:';

  if (entry.external.secure === 'wss') {
    return `${secure ? 'wss' : 'ws'}://${host}${entry.external.path}`;
  }
  return `${secure ? 'https' : 'http'}://${host}${entry.external.path}`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      title="주소 복사"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* 클립보드를 못 쓰면 사용자가 직접 고르면 된다 */
        }
      }}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

/**
 * WebSocket 주소는 터미널에서 확인하기가 번거롭습니다. 브라우저에서 실제로
 * 핸드셰이크를 해 봅니다 — **서브프로토콜까지 그대로** 요청하므로 클라이언트가
 * 겪을 것과 같은 경로입니다.
 */
function WsProbe({ url }) {
  const [state, setState] = useState(null); // null | 'trying' | 'ok' | 오류 문구

  const tryConnect = () => {
    setState('trying');
    let socket;
    const done = (value) => {
      setState(value);
      try {
        socket?.close();
      } catch {
        /* 이미 닫혔다 */
      }
    };

    try {
      socket = new WebSocket(url, 'janus-protocol');
    } catch (err) {
      return done(err.message || '열 수 없습니다');
    }

    const timer = setTimeout(() => done('응답이 없습니다 (5초)'), 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      done('ok');
    };
    socket.onerror = () => {
      clearTimeout(timer);
      // 브라우저는 보안상 이유로 실패 원인을 알려 주지 않는다.
      done('붙지 못했습니다 — nginx 라우트와 Janus 의 ws 설정을 보세요');
    };
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={tryConnect} disabled={state === 'trying'}>
        {state === 'trying' ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
        붙어 보기
      </Button>
      {state === 'ok' && <span className="text-xs text-success">핸드셰이크 성공 (janus-protocol)</span>}
      {state && state !== 'ok' && state !== 'trying' && (
        <span className="text-xs text-destructive">{state}</span>
      )}
    </div>
  );
}

function AddressRow({ entry }) {
  const url = externalUrl(entry);

  return (
    <div className={cn('space-y-1.5 rounded-md border p-3', !entry.enabled && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{entry.label}</span>
        {entry.websocket && <Badge variant="secondary">WebSocket</Badge>}
        {!entry.enabled && <Badge variant="outline">선언이 꺼져 있음</Badge>}
        <Badge variant={entry.listening ? 'success' : 'destructive'}>
          {entry.listening ? `듣는 중 :${entry.port}` : `:${entry.port} 안 열림`}
        </Badge>
      </div>

      {entry.use && <p className="text-xs text-muted-foreground">{entry.use}</p>}

      {url ? (
        <div className="flex items-center gap-1">
          <code className="flex-1 truncate rounded bg-muted/50 px-2 py-1 font-mono text-xs">{url}</code>
          <CopyButton text={url} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">밖으로 열려 있지 않습니다.</p>
      )}

      <p className="font-mono text-[11px] text-muted-foreground">
        안에서: {entry.internal || '—'}
      </p>

      {entry.note && <p className="text-xs text-warning">{entry.note}</p>}
      {entry.websocket && url && <WsProbe url={url} />}
    </div>
  );
}

export function AddressCard({ data }) {
  if (!data?.entries?.length) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="size-4" />
          접속 주소
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 lg:grid-cols-2">
          {data.entries.map((entry) => (
            <AddressRow key={`${entry.service}/${entry.key}`} entry={entry} />
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          주소는 <span className="font-mono">{data.declaredIn}</span> 의 선언에서 옵니다 — nginx 설정을
          만드는 바로 그 파일입니다. 오리진(<span className="font-mono">{window.location.host}</span>)은 지금 이
          페이지를 연 주소를 그대로 씁니다.
        </p>
        <p className="text-xs text-muted-foreground">
          <strong>선언이 곧 반영은 아닙니다.</strong> 선언을 고친 뒤{' '}
          <span className="font-mono">sudo ./install_nginx_stack.sh --skip-install</span> 를 돌리지 않았으면
          위 주소는 아직 nginx 에 없습니다. 배지의 포트는 <em>서버 안에서</em> 실제로 듣고 있는지입니다.
        </p>
      </CardContent>
    </Card>
  );
}
