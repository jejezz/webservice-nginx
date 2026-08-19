import { AlertCircle, Cpu, Database, DoorOpen, House, RefreshCw, Server, Smartphone, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatUptime } from '@/lib/format';
import { InfoCard, StatTile } from '@/components/InfoCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function Overview() {
  const { data, error, loading, refreshing, reload } = usePolling(api.overview, 5000);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-56" />
      </div>
    );
  }

  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error || '데이터를 불러오지 못했습니다.'}</AlertDescription>
      </Alert>
    );
  }

  const { database, mobiles, homenet } = data;

  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">개요</h2>
        <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
          새로고침
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="활성 방" value={data.rooms} hint="시그널링이 진행 중인 방" />
        <StatTile label="접속 클라이언트" value={data.connections} hint="열려 있는 WebSocket" />
        <StatTile
          label="등록 단말"
          value={mobiles ? mobiles.total : '—'}
          hint={mobiles ? `활성 ${mobiles.active}` : 'DB 연결 없음'}
        />
        <StatTile
          label="홈넷 장치"
          value={homenet ? homenet.total : '—'}
          hint={homenet ? undefined : 'DB 연결 없음'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <InfoCard
          title="서비스"
          Icon={Server}
          columns={1}
          rows={[
            ['이름', data.service],
            ['가동 시간', formatUptime(data.uptimeSec)],
            ['PID', data.pid],
            ['메모리 (RSS)', `${data.memoryMb} MB`],
            ['NODE_ENV', data.nodeEnv],
            ['HTTPS 포트', data.httpsPort, '단말이 직접 붙는 포트. 자체 인증서를 쓴다'],
          ]}
        />

        <InfoCard
          title="데이터베이스"
          Icon={Database}
          columns={1}
          action={
            <Badge variant={database?.ok ? 'success' : 'destructive'}>
              {database?.ok ? '정상' : database?.configured ? '연결 실패' : '미설정'}
            </Badge>
          }
          rows={[
            ['스키마', database?.database],
            ['설정됨', database?.configured ? '예' : '아니오'],
            ['오류', database?.error],
            ['등록 단말', mobiles ? `${mobiles.total} (활성 ${mobiles.active})` : null],
            ['홈넷 장치', homenet ? homenet.total : null],
          ]}
        />
      </div>
    </>
  );
}
