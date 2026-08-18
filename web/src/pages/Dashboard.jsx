import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  LogOut,
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
