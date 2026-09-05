import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ListChecks,
  LogOut,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useAuth } from '@/context/auth';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, formatTime, formatUptime } from '@/lib/format';
import { StatCard } from '@/components/StatCard';
import { ServiceTable } from '@/components/ServiceTable';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const REFRESH_INTERVAL_MS = 5000;

const CERT_KIND_LABEL = {
  letsencrypt: 'Let\u2019s Encrypt (공인)',
  'letsencrypt-staging': 'Let\u2019s Encrypt STAGING',
  'private-ca': '사설 CA',
  unknown: '알 수 없음',
};

/**
 * 서버가 **지금 내밀고 있는** 인증서.
 *
 * 파일이 아니라 TLS 접속으로 읽으므로, 갱신은 됐는데 nginx 가 reload 되지 않아
 * 옛 인증서가 나가는 상태도 여기서 드러난다.
 */
function CertCard({ cert }) {
  if (!cert?.ok) {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            TLS 인증서
          </CardTitle>
          <Badge variant="destructive">확인 불가</Badge>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {cert?.port ? `127.0.0.1:${cert.port} 에서 인증서를 받지 못했습니다.` : '상태를 읽지 못했습니다.'}
            {cert?.error ? ` (${cert.error})` : ''}
          </p>
        </CardContent>
      </Card>
    );
  }

  const tone = cert.level === 'critical' ? 'destructive' : cert.level === 'warn' ? 'warning' : 'success';
  const rows = [
    ['종류', CERT_KIND_LABEL[cert.kind] || cert.kind],
    ['이름', cert.subject || '—'],
    ['발급자', cert.issuer || '—'],
    ['만료', `${formatDateTime(cert.expiresAt)} (${cert.daysLeft}일)`],
    ['자동 갱신', cert.renewTimer === 'active' ? 'certbot.timer 동작 중' : `certbot.timer — ${cert.renewTimer}`],
  ];
  if (cert.dns) {
    rows.push([
      'DNS',
      cert.dns.ok
        ? `이 서버를 가리킴 (${cert.dns.current})`
        : `${cert.dns.resolved || '레코드 없음'} — 지금은 ${cert.dns.current || '?'}`,
    ]);
  }

  // 무엇을 해야 하는지까지 적는다. 상태만 보여 주면 결국 문서를 뒤지게 된다.
  const notes = [];
  if (cert.kind === 'letsencrypt-staging') {
    notes.push('시험용 인증서가 물려 있습니다. 브라우저와 앱이 거부합니다 — 실제 발급으로 바꾸세요.');
  }
  if (cert.kind === 'private-ca') {
    notes.push('사설 CA 입니다. 앱이 CA 를 미리 심어야만 접속됩니다 — 공인 인증서로 이관이 남았습니다.');
  }
  if (cert.kind === 'letsencrypt' && cert.renewTimer !== 'active') {
    notes.push('자동 갱신이 꺼져 있습니다. 90일 뒤 조용히 만료됩니다.');
  }
  if (cert.daysLeft != null && cert.daysLeft < 30) {
    notes.push('만료가 가깝습니다. 갱신이 도는지 확인하세요.');
  }
  if (cert.dns && !cert.dns.ok) {
    // 유동 IP 인데 A 레코드가 고정이라 생기는 일이다. 지금 아무도 못 붙는 상태다.
    notes.push(
      `이름이 이 서버를 가리키지 않습니다. 앱이 접속하지 못합니다 — 등록기관에서 A 레코드를 ${cert.dns.current || '현재 공인 IP'} 로 고치세요.`,
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4" />
          TLS 인증서
        </CardTitle>
        <Badge variant={tone}>{cert.daysLeft != null ? `${cert.daysLeft}일 남음` : cert.level}</Badge>
      </CardHeader>

      <CardContent>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="truncate font-mono text-xs">{String(value)}</dd>
            </div>
          ))}
        </dl>
        {notes.length > 0 && (
          <ul className="mt-3 space-y-1">
            {notes.map((n) => (
              <li key={n} className="text-xs text-muted-foreground">· {n}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function NginxCard({ nginx, server }) {
  const rows = [
    ['상태', nginx.active ? `${nginx.state} (${nginx.subState || '-'})` : nginx.state],
    ['버전', nginx.version || '—'],
    ['PID', nginx.mainPid ?? '—'],
    ['가동 시간', formatUptime(nginx.uptimeSec)],
    ['시작 시각', formatDateTime(nginx.startedAt)],
    ['server_name', server.serverName || '—'],
    ['HTTP / HTTPS', `${server.listenPort ?? '—'} / ${server.sslPort ?? '—'}`],
    ['mTLS', server.mtls ? `ssl_verify_client = ${server.sslVerifyClient}` : '미사용'],
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="size-4" />
          Nginx
        </CardTitle>
        <Badge variant={nginx.active ? 'success' : 'destructive'}>
          {nginx.active ? 'active' : nginx.state}
        </Badge>
      </CardHeader>

      <CardContent>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="truncate font-mono text-xs">{String(value)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[104px]" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export default function Dashboard() {
  const { user, logout } = useAuth();

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rechecking, setRechecking] = useState(null);

  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await api.overview();
      if (!mounted.current) return;
      setData(result);
      setError('');
    } catch (err) {
      if (!mounted.current) return;
      // 세션 만료 시 로그인 화면으로 돌아간다.
      if (err instanceof ApiError && err.status === 401) {
        await logout();
        return;
      }
      setError(err.message || '데이터를 불러오지 못했습니다.');
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [logout]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  const recheck = useCallback(async (name) => {
    setRechecking(name);
    try {
      const result = await api.serviceHealth(name);
      if (!mounted.current) return;
      setData((prev) =>
        prev
          ? {
              ...prev,
              services: prev.services.map((s) => (s.name === name ? { ...s, health: result.health } : s)),
            }
          : prev
      );
    } catch {
      // 개별 재확인 실패는 다음 자동 갱신에서 회복된다.
    } finally {
      if (mounted.current) setRechecking(null);
    }
  }, []);

  const summary = data?.summary;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg border bg-card">
              <Activity className="size-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Nginx Manager</h1>
              <p className="text-xs text-muted-foreground">
                {data?.server?.serverName ? `${data.server.serverName} · ` : ''}
                {data?.updatedAt ? `갱신 ${formatTime(data.updatedAt)}` : '불러오는 중…'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            <div className="hidden items-center gap-2 sm:flex">
              <Switch id="auto-refresh" checked={autoRefresh} onCheckedChange={setAutoRefresh} />
              <Label htmlFor="auto-refresh" className="cursor-pointer text-xs text-muted-foreground">
                자동 갱신 {REFRESH_INTERVAL_MS / 1000}초
              </Label>
            </div>

            <Button variant="outline" size="sm" asChild title="구축 마법사">
              <Link to="/setup">
                <ListChecks className="size-3.5" />
                <span className="hidden sm:inline">구축</span>
              </Link>
            </Button>

            <Button variant="outline" size="sm" asChild title="포트 지도 — 공유기 포워딩 확인">
              <Link to="/port-map">
                <Network className="size-3.5" />
                <span className="hidden sm:inline">포트</span>
              </Link>
            </Button>

            <Button variant="outline" size="sm" asChild title="문서 · 변경 이력">
              <Link to="/docs">
                <BookOpen className="size-3.5" />
                <span className="hidden sm:inline">문서</span>
              </Link>
            </Button>

            <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
              <span className="hidden sm:inline">새로고침</span>
            </Button>

            <div className="hidden text-right md:block">
              <p className="text-xs font-medium leading-tight">{user?.displayName}</p>
              <p className="text-xs text-muted-foreground">{user?.username}</p>
            </div>

            <Button variant="ghost" size="icon" onClick={logout} title="로그아웃">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!data ? (
          <LoadingSkeleton />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="전체 서비스"
                value={summary.total}
                Icon={Server}
                hint={`nginx 라우트 ${data.services.filter((s) => s.sources?.includes('nginx')).length} · PM2 ${data.services.filter((s) => s.sources?.includes('pm2')).length}`}
              />
              <StatCard label="정상" value={summary.up} tone="success" Icon={CheckCircle2} hint="/health 응답 정상" />
              <StatCard
                label="비정상"
                value={summary.down + summary.degraded}
                tone={summary.down + summary.degraded > 0 ? 'destructive' : 'default'}
                Icon={XCircle}
                hint={`중단 ${summary.down} · 주의 ${summary.degraded}`}
              />
              <StatCard
                label="Nginx"
                value={data.nginx.active ? '실행 중' : '중지됨'}
                tone={data.nginx.active ? 'success' : 'destructive'}
                Icon={ShieldCheck}
                hint={data.nginx.version ? `v${data.nginx.version}` : '버전 확인 불가'}
              />
            </div>

            <NginxCard nginx={data.nginx} server={data.server} />
            <CertCard cert={data.cert} />

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">서비스</CardTitle>
                <div className="text-right">
                  <p className="font-mono text-xs text-muted-foreground">{data.source.path}</p>
                  {data.source.ecosystemPath && (
                    <p className="font-mono text-xs text-muted-foreground">{data.source.ecosystemPath}</p>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <ServiceTable services={data.services} onRecheck={recheck} rechecking={rechecking} />
              </CardContent>
            </Card>

            <p className="pb-4 text-center text-xs text-muted-foreground">
              상태는 각 서비스의 <code className="font-mono">/health</code> 엔드포인트를 직접 호출해 판정합니다.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
