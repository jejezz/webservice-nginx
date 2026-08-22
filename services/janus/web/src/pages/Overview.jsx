import { AlertCircle, Activity, Cpu, Network, Puzzle, RefreshCw } from 'lucide-react';
import { AddressCard } from '@/components/AddressCard';
import { InfoCard, StatTile } from '@/components/InfoCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';

export default function Overview() {
  const { data, error, loading, refreshing, reload } = usePolling(api.overview, 5000);
  // 주소는 선언에서 오므로 자주 바뀌지 않는다. 개요보다 느리게 본다.
  const { data: addresses } = usePolling(api.addresses, 30000);

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
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

  /*
   * Janus 가 떠 있지 않아도 이 화면은 뜬다. 대시보드와 Janus 는 다른
   * 프로세스이고, 대시보드가 살아 있어야 Janus 가 죽은 것을 볼 수 있다.
   */
  if (!data?.running) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Janus 에 닿지 않습니다</AlertTitle>
          <AlertDescription className="space-y-2">
            <p className="font-mono text-xs">{data?.error} — {data?.apiBase}</p>
            <p>
              설정과 systemd 유닛이 아직 설치되지 않았을 수 있습니다. 서버에서
              다음을 실행하세요.
            </p>
            <pre className="rounded bg-muted/50 p-2 font-mono text-xs">
              cd services/janus{'\n'}
              sudo ./install.sh --apply{'\n'}
              ./install.sh            # 상태 확인
            </pre>
          </AlertDescription>
        </Alert>

        {/* Janus 가 죽어 있을 때야말로 "어디로 붙는 곳이었는지" 를 봐야 한다.
            포트 배지가 무엇이 안 열렸는지 그대로 보여 준다. */}
        <AddressCard data={addresses} />

        <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          다시 확인
        </Button>
      </div>
    );
  }

  const { server, ice, plugins, transports, admin } = data;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="상태" value="구동 중" tone="success" hint={`응답 ${data.latencyMs}ms`} />
        <StatTile
          label="Admin API"
          value={admin.ok ? '연결됨' : '닿지 않음'}
          tone={admin.ok ? 'success' : 'warning'}
          hint={admin.ok ? '세션·미디어 상태를 읽을 수 있습니다' : admin.error}
        />
        <StatTile
          label="새 세션"
          value={server.acceptingNewSessions ? '받는 중' : '거부'}
          tone={server.acceptingNewSessions ? 'success' : 'warning'}
          hint={`세션 타임아웃 ${server.sessionTimeout}초`}
        />
      </div>

      {!admin.ok && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>Admin API 에 닿지 않습니다</AlertTitle>
          <AlertDescription className="space-y-1">
            <p className="font-mono text-xs">{admin.error}</p>
            <p>
              세션·핸들·미디어 화면(계획서 8단계)이 이 경로를 씁니다. 개요와 시험
              통화는 영향을 받지 않습니다. 대개 secrets/admin-secret 을 이 프로세스가
              읽지 못하는 경우입니다.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <InfoCard
          title="서버"
          Icon={Cpu}
          columns={1}
          rows={[
            ['이름', server.serverName],
            ['버전', server.version],
            ['커밋', server.commit?.slice(0, 12)],
            ['빌드 시각', server.compiledAt],
            ['로컬 IP', server.localIp, 'SDP 와 ICE 후보에 실리는 주소'],
          ]}
        />
        <InfoCard
          title="ICE"
          Icon={Network}
          columns={1}
          rows={[
            ['모드', ice.lite ? 'ICE Lite' : 'Full'],
            ['후보 방식', ice.fullTrickle ? 'full-trickle' : 'half-trickle'],
            ['ICE-TCP', ice.tcp ? '켜짐' : '꺼짐'],
            ['IPv6', ice.ipv6 ? '켜짐' : '꺼짐'],
            ['nomination', ice.nomination],
          ]}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Puzzle className="size-4" />
            올라온 모듈
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">플러그인</p>
            <div className="flex flex-wrap gap-1.5">
              {plugins.map((name) => (
                <Badge key={name} variant="secondary" className="font-mono text-xs">
                  {name.replace(/^janus\.plugin\./, '')}
                </Badge>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">트랜스포트</p>
            <div className="flex flex-wrap gap-1.5">
              {transports.map((name) => (
                <Badge key={name} variant="secondary" className="font-mono text-xs">
                  {name.replace(/^janus\.transport\./, '')}
                </Badge>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            안 쓰는 플러그인은 janus.jcfg 의 <span className="font-mono">plugins.disable</span> 로
            올리지 않습니다. 트랜스포트는 REST(8088)와 WebSocket(8188) 둘을 엽니다 — 헬스는 REST 로
            가고 WebRTC 클라이언트는 WS 로 붙습니다 (계획서 ① 절).
          </p>
        </CardContent>
      </Card>

      <AddressCard data={addresses} />

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          새로 고침
        </Button>
        <span className="text-xs text-muted-foreground">
          <Activity className="mr-1 inline size-3" />5초마다 자동 갱신
        </span>
      </div>
    </div>
  );
}
