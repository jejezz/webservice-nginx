import { Activity, AlertCircle, Cpu, RefreshCw, Server } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatUptime, formatTime } from '@/lib/format';
import { InfoCard, StatTile } from '@/components/InfoCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const mb = (bytes) => (bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : '—');

/** 워커 이름에서 눈여겨볼 것만 골라 배지로 보여준다. */
const NOTABLE = [
  { match: /websocket/i, label: 'WebSocket', variant: 'success' },
  { match: /tcp receiver/i, label: 'TCP', variant: 'secondary' },
  { match: /udp receiver/i, label: 'UDP', variant: 'secondary' },
];

export default function Overview() {
  const { data, error, loading, refreshing, reload } = usePolling(api.overview, 5000);

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const { service, kamailio, summary } = data;
  const rpcDown = Boolean(kamailio.error) || kamailio.uptimeSec === null;

  // 워커 이름별 개수. 20개를 다 나열하는 대신 종류로 묶어 보여준다.
  const workerKinds = (kamailio.workers || []).reduce((acc, w) => {
    const kind = w.description.replace(/\s*\(.*\)|\s*child=\d+/g, '').trim();
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {rpcDown && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>
            Kamailio 에 닿지 않습니다{kamailio.error ? `: ${kamailio.error}` : ''}. 대시보드는 살아 있지만
            상태를 읽지 못합니다. <code className="font-mono">systemctl status kamailio</code> 를 확인하세요.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="등록 단말"
          value={summary.registrations}
          hint={Object.entries(summary.transports).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}
          tone={summary.registrations > 0 ? 'success' : 'default'}
        />
        <StatTile
          label="WebSocket 연결"
          value={summary.websockets}
          hint="SIP over WS 단말"
          tone={summary.websockets > 0 ? 'success' : 'default'}
        />
        <StatTile
          label="Kamailio 가동"
          value={kamailio.uptimeSec === null ? '—' : formatUptime(kamailio.uptimeSec)}
          hint={kamailio.upSince || ''}
          tone={rpcDown ? 'destructive' : 'default'}
        />
        <StatTile
          label="공유 메모리"
          value={kamailio.shmem ? `${Math.round((kamailio.shmem.real_used / kamailio.shmem.total) * 100)}%` : '—'}
          hint={kamailio.shmem ? `${mb(kamailio.shmem.real_used)} / ${mb(kamailio.shmem.total)}` : ''}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <InfoCard
          title="Kamailio"
          Icon={Server}
          columns={1}
          rows={[
            ['버전', kamailio.version],
            ['SIP 도메인', kamailio.domains?.length ? kamailio.domains.join(', ') : '—'],
            ['가동 시작', kamailio.upSince],
            ['공유 메모리 사용', kamailio.shmem ? `${mb(kamailio.shmem.real_used)} / ${mb(kamailio.shmem.total)}` : '—'],
            ['패키지 메모리 사용', kamailio.pkgTotal ? `${mb(kamailio.pkgTotal.real_used)} / ${mb(kamailio.pkgTotal.total_size)}` : '—'],
            ['워커 수', kamailio.workers?.length ?? '—'],
          ]}
        />

        <InfoCard
          title="대시보드 서비스"
          Icon={Activity}
          columns={1}
          action={
            <Button variant="ghost" size="sm" onClick={reload} disabled={refreshing}>
              <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
          }
          rows={[
            ['이름', service.name],
            ['버전', service.version],
            ['호스트', service.hostname],
            ['PID', service.pid],
            ['Node', service.nodeVersion],
            ['가동', formatUptime(service.uptimeSec)],
            ['메모리', `${service.memoryMb} MB`],
            ['갱신', formatTime(data.updatedAt)],
          ]}
        />
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4" />
            워커 프로세스
          </CardTitle>
        </CardHeader>
        <CardContent>
          {kamailio.workers?.length ? (
            <div className="flex flex-wrap gap-2">
              {Object.entries(workerKinds)
                .sort((a, b) => b[1] - a[1])
                .map(([kind, count]) => {
                  const notable = NOTABLE.find((n) => n.match.test(kind));
                  return (
                    <Badge key={kind} variant={notable?.variant || 'outline'} className="font-normal">
                      {kind}
                      {count > 1 && <span className="ml-1.5 opacity-60">×{count}</span>}
                    </Badge>
                  );
                })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">워커 정보를 읽지 못했습니다.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
