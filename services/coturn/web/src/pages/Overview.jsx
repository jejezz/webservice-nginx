import { AlertCircle, KeyRound, Network, Package, RefreshCw, ShieldAlert } from 'lucide-react';
import { InfoCard, StatTile } from '@/components/InfoCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';

const CONFIG_LABEL = {
  same: '저장소와 같음',
  differs: '저장소와 다름 — 반영 필요',
  missing: '설치되지 않음',
  unreadable: '읽을 수 없음 (권한)',
  'no-template': '견줄 원본이 없음',
};

export default function Overview() {
  const { data, error, loading, refreshing, reload } = usePolling(api.overview, 5000);

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

  const { status, settings } = data;
  const active = status.serviceState === 'active';

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="coturn 상태"
          value={active ? '구동 중' : status.serviceState}
          tone={active ? 'success' : 'destructive'}
          hint={status.packageInstalled ? '패키지 설치됨' : '패키지 설치 안 됨'}
        />
        <StatTile
          label="설정"
          value={CONFIG_LABEL[status.config.state] || status.config.state}
          tone={status.config.state === 'same' ? 'success' : status.config.state === 'unreadable' ? 'default' : 'warning'}
          hint="/etc/turnserver.conf ↔ turnserver.conf"
        />
        <StatTile
          label="부팅 시 자동 기동"
          value={status.serviceEnabled ? '켜짐' : '꺼짐'}
          tone={status.serviceEnabled ? 'success' : 'warning'}
          hint={status.defaultFileEnabled ? 'TURNSERVER_ENABLED=1' : '/etc/default/coturn 확인 필요'}
        />
      </div>

      {!status.packageInstalled && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>coturn 이 설치되지 않았습니다</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>서버에서 다음을 실행하세요.</p>
            <pre className="rounded bg-muted/50 p-2 font-mono text-xs">
              cd services/coturn{'\n'}
              sudo ./install.sh --apply{'\n'}
              ./install.sh            # 상태 확인
            </pre>
          </AlertDescription>
        </Alert>
      )}

      {status.packageInstalled && !active && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>coturn 이 떠 있지 않습니다</AlertTitle>
          <AlertDescription className="font-mono text-xs">
            journalctl -u coturn -n 40 --no-pager
          </AlertDescription>
        </Alert>
      )}

      {!settings.public_ip && (
        <Alert>
          <ShieldAlert className="size-4" />
          <AlertTitle>공인 IP 가 비어 있습니다</AlertTitle>
          <AlertDescription className="space-y-1 text-xs">
            <p>
              이 TURN 서버를 만든 이유는 <strong>셀룰러 데이터를 쓰는 모바일의 NAT 통과</strong>입니다.
              공인 IP 없이는 LAN 전용으로만 동작해 그 목적을 채우지 못합니다.
            </p>
            <p>
              보통은 <span className="font-mono">services/janus/settings.ini</span> 의 공인 IP 를 그대로
              물려받습니다 — 그것도 비어 있으면 이 화면 아래의 <strong>설정</strong> 탭에서 직접 넣으세요.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <InfoCard
          title="접속 정보"
          Icon={Network}
          columns={1}
          rows={[
            ['공인 IP', settings.public_ip || '(없음 — LAN 전용)'],
            ['realm', settings.realm],
            ['수신 포트', settings.listening_port, 'STUN/TURN, UDP+TCP'],
            ['릴레이 포트 범위', settings.relay_port_range, 'UDP, 공유기 포워딩 필요'],
          ]}
        />
        <InfoCard
          title="인증"
          Icon={KeyRound}
          columns={1}
          rows={[
            ['방식', 'TURN REST API (use-auth-secret)'],
            ['정적 비밀', status.staticAuthSecretPresent ? '있음' : '없음 — sudo ./install.sh --apply'],
            ['값 자체', '이 화면에 표시하지 않습니다 (아래 참고)'],
          ]}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="size-4" />
            이 화면이 보여 주지 않는 것
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">활성 세션·릴레이 할당 개수</strong> — coturn 의 관리
            CLI(기본 포트 5766)를 열어야 알 수 있는데, 이 배치는 v1 이라 CLI 를 껐습니다
            (<span className="font-mono">turnserver.conf</span> 의 <span className="font-mono">no-cli</span>).
            세션 하나를 세는 것보다 관리 채널을 닫아 두는 편의 이득이 크다고 판단했습니다. 필요해지면
            그 파일의 주석을 보고 켜세요.
          </p>
          <p>
            <strong className="text-foreground">static-auth-secret 의 값</strong> — 이 값을 알면 누구나
            임의로 TURN 자격 증명을 계산해 릴레이를 쓸 수 있습니다. 화면에 내려보내지 않고 존재 여부만
            보여줍니다.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          새로 고침
        </Button>
        <span className="text-xs text-muted-foreground">5초마다 자동 갱신</span>
        {!active && <Badge variant="secondary" className="ml-auto">읽기 전용 — 재시작은 sudo ./install.sh --apply 로</Badge>}
      </div>
    </div>
  );
}
