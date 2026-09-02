import { AlertCircle } from 'lucide-react';
import { StatTile } from '@/components/InfoCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';

/**
 * 세션 · 핸들 · SIP 상태 · 미디어 (계획서 8-2 ~ 8-4).
 *
 * **읽기만 한다.** 세션을 끊는 단추는 두지 않는다 — kamailio-dashboard 와 같은
 * 자세다. 통화를 끊는 것은 단말이 할 일이고, Janus 를 다루는 것은 install.sh 다.
 */

const KB = 1024;
function bytes(n) {
  if (!n) return '0';
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${(n / KB).toFixed(1)} KB`;
  return `${(n / KB / KB).toFixed(1)} MB`;
}

/** 통화 상태에 따라 뱃지 색을 고른다. idle 은 조용히, 통화 중은 눈에 띄게. */
function callBadge(status) {
  if (!status || status === 'idle') return 'secondary';
  if (status === 'incall') return 'default';
  return 'outline';   // calling · inviting · ringing …
}

function MediaTable({ media }) {
  if (!media?.length) return <p className="text-xs text-muted-foreground">미디어 없음</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>종류</TableHead>
          <TableHead>코덱</TableHead>
          <TableHead className="text-right">수신</TableHead>
          <TableHead className="text-right">송신</TableHead>
          <TableHead className="text-right">손실</TableHead>
          <TableHead className="text-right">지터</TableHead>
          <TableHead className="text-right">RTT</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {media.map((m) => (
          <TableRow key={m.mid}>
            <TableCell className="font-medium">
              {m.type}
              <span className="ml-1 text-xs text-muted-foreground">mid {m.mid}</span>
            </TableCell>
            <TableCell className="font-mono text-xs">
              {m.codec ? `${m.codec}${m.payloadType != null ? ` (${m.payloadType})` : ''}` : '협상 전'}
            </TableCell>
            <TableCell className="text-right font-mono text-xs">
              {m.in.packets}
              <span className="ml-1 text-muted-foreground">{bytes(m.in.bytes)}</span>
            </TableCell>
            <TableCell className="text-right font-mono text-xs">
              {m.out.packets}
              <span className="ml-1 text-muted-foreground">{bytes(m.out.bytes)}</span>
            </TableCell>
            <TableCell className="text-right font-mono text-xs">{m.quality.lost ?? '—'}</TableCell>
            <TableCell className="text-right font-mono text-xs">{m.quality.jitterLocal ?? '—'}</TableCell>
            <TableCell className="text-right font-mono text-xs">{m.quality.rtt ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function HandleCard({ h }) {
  if (h.error) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          핸들 {h.handleId} — 읽지 못했습니다: {h.error}
        </CardContent>
      </Card>
    );
  }

  const inCall = h.sip?.callStatus && h.sip.callStatus !== 'idle';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm font-mono">{h.sip?.identity || h.plugin || '핸들'}</CardTitle>
          {h.sip?.registrationStatus && (
            <Badge variant={h.sip.registrationStatus === 'registered' ? 'default' : 'secondary'}>
              {h.sip.registrationStatus}
            </Badge>
          )}
          {h.sip?.callStatus && (
            <Badge variant={callBadge(h.sip.callStatus)}>{h.sip.callStatus}</Badge>
          )}
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            핸들 {h.handleId}
          </span>
        </div>
        {inCall && (h.sip.callee || h.sip.caller) && (
          <p className="font-mono text-xs text-muted-foreground">
            {h.sip.caller ? `← ${h.sip.caller}` : `→ ${h.sip.callee}`}
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {/*
          webrtc 절은 PeerConnection 이 올라와 있을 때만 생긴다. 등록만 해 둔
          핸들에는 없는 것이 정상이라, 없다고 오류처럼 보이면 안 된다.
        */}
        {h.webrtc ? (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                ICE <span className="font-mono">{h.webrtc.ice.state ?? '—'}</span>
              </span>
              <span>
                DTLS <span className="font-mono">{h.webrtc.dtls.state ?? '—'}</span>
                {h.webrtc.dtls.role ? <span className="text-muted-foreground"> ({h.webrtc.dtls.role})</span> : null}
              </span>
              <span>
                SRTP <span className="font-mono">{h.webrtc.dtls.srtpProfile ?? '—'}</span>
              </span>
            </div>
            {h.webrtc.ice.selectedPair && (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {h.webrtc.ice.selectedPair}
              </p>
            )}
            <MediaTable media={h.webrtc.media} />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            PeerConnection 없음 — 등록만 되어 있고 통화 중이 아닙니다.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Sessions() {
  const { data, error, loading } = usePolling(api.sessions, 3000);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Skeleton className="h-24" /><Skeleton className="h-24" />
          <Skeleton className="h-24" /><Skeleton className="h-24" />
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>불러오지 못했습니다</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!data?.ok) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Admin API 에 닿지 않습니다</AlertTitle>
        <AlertDescription className="space-y-2">
          <p className="font-mono text-xs">{data?.error}</p>
          <p>
            Janus 가 떠 있는지, <code>secrets/admin-secret</code> 이 설치된
            <code> janus.jcfg</code> 의 값과 같은지 확인하세요.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const c = data.counts;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="세션" value={c.sessions} />
        <StatTile label="핸들" value={c.handles} />
        <StatTile label="등록됨" value={c.registered} tone={c.registered ? 'success' : 'default'} />
        <StatTile label="통화 중" value={c.inCall} tone={c.inCall ? 'success' : 'default'} />
      </div>

      {data.truncatedSessions > 0 && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertDescription>
            세션이 많아 {data.truncatedSessions}개를 생략했습니다.
          </AlertDescription>
        </Alert>
      )}

      {data.sessions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            열려 있는 세션이 없습니다.
            <p className="mt-1 text-xs">
              세션은 클라이언트가 keepalive 를 멈춘 뒤 <code>session_timeout</code>
              (기본 60초)이 지나야 사라집니다 — 통화를 끊자마자 여기서 없어지지는
              않습니다.
            </p>
          </CardContent>
        </Card>
      ) : (
        data.sessions.map((s) => (
          <section key={s.id} className="space-y-3">
            <h2 className="font-mono text-sm text-muted-foreground">세션 {s.id}</h2>
            {s.error ? (
              <Card>
                <CardContent className="py-4 text-sm text-muted-foreground">
                  핸들을 읽지 못했습니다: {s.error}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {s.handles.map((h) => <HandleCard key={h.handleId} h={h} />)}
              </div>
            )}
          </section>
        ))
      )}

      <p className="text-xs text-muted-foreground">
        여기 보이는 패킷 수는 <strong>WebRTC 다리</strong>의 것입니다. 상대(SIP)
        쪽으로 얼마나 나갔는지는 Janus 가 Admin API 로 내주지 않습니다 — 그쪽은
        rtpproxy 에 물어야 합니다 (<code>test-harness/probe-peer.js</code>).
      </p>
    </div>
  );
}
