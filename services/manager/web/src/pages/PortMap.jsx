import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Network, RefreshCw, Router } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth';
import { formatTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function ForwardBadge({ forwarded }) {
  return (
    <Badge variant={forwarded ? 'warning' : 'outline'}>
      {forwarded ? '공유기 포워딩 필요' : 'LAN 전용'}
    </Badge>
  );
}

function RtpTable({ rows }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>역할</TableHead>
          <TableHead>대역</TableHead>
          <TableHead>프로토콜</TableHead>
          <TableHead>공유기 포워딩</TableHead>
          <TableHead>비고</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.role}>
            <TableCell className="font-medium">{r.role}</TableCell>
            <TableCell className="font-mono">{r.value ?? '—'}</TableCell>
            <TableCell>{r.protocol}</TableCell>
            <TableCell><ForwardBadge forwarded={r.forwarded} /></TableCell>
            <TableCell className="max-w-md text-xs text-muted-foreground">{r.note || '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ControlTable({ rows }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>이름</TableHead>
          <TableHead>값</TableHead>
          <TableHead>프로토콜</TableHead>
          <TableHead>공유기 포워딩</TableHead>
          <TableHead>비고</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.name}>
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell className="font-mono">{r.value ?? '—'}</TableCell>
            <TableCell>{r.protocol}</TableCell>
            <TableCell><ForwardBadge forwarded={r.forwarded} /></TableCell>
            <TableCell className="max-w-md text-xs text-muted-foreground">{r.note || '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function InternalHttpTable({ rows }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>서비스</TableHead>
          <TableHead>포트</TableHead>
          <TableHead>nginx location</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.name}>
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell className="font-mono">{(r.ports || []).join(', ') || '—'}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{r.location || '— (직결)'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ChecklistTable({ rows }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>프로토콜</TableHead>
          <TableHead>포트</TableHead>
          <TableHead>용도</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.protocol}-${r.port}`}>
            <TableCell className="font-medium">{r.protocol}</TableCell>
            <TableCell className="font-mono">{r.port}</TableCell>
            <TableCell>{r.purpose}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-48" />
      ))}
    </div>
  );
}

export default function PortMap() {
  const { logout } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await api.portMap();
      if (!mounted.current) return;
      setData(result);
      setError('');
    } catch (err) {
      if (!mounted.current) return;
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

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" asChild title="대시보드로">
              <Link to="/dashboard">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <div className="flex size-9 items-center justify-center rounded-lg border bg-card">
              <Network className="size-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">포트 지도</h1>
              <p className="text-xs text-muted-foreground">
                {data?.generatedAt ? `갱신 ${formatTime(data.generatedAt)}` : '불러오는 중…'}
              </p>
            </div>
          </div>

          <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
            <span className="hidden sm:inline">새로고침</span>
          </Button>
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
            <Card className="border-warning/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Router className="size-4" />
                  공유기 포트 포워딩 체크리스트
                </CardTitle>
                <CardDescription>
                  공유기를 바꾸거나 포워딩을 다시 확인할 때는 이 표만 보면 됩니다. 여기 없는 포트는 전부 LAN 전용입니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <ChecklistTable rows={data.forwardingChecklist} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">RTP/미디어 (UDP) — 실제 통화 소리가 오가는 대역</CardTitle>
                <CardDescription>각 역할이 자기 대역을 쓰고, 서로 겹치지 않습니다.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <RtpTable rows={data.rtp} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">시그널링 · 컨트롤 포트</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <ControlTable rows={data.control} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">내부 HTTP 포트 (nginx 라우팅)</CardTitle>
                <CardDescription>전부 127.0.0.1 백엔드 — 공유기 포워딩 대상이 아닙니다.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <InternalHttpTable rows={data.internalHttp} />
              </CardContent>
            </Card>

            <p className="pb-4 text-center text-xs text-muted-foreground">
              값은 각 서비스의 settings.ini(없으면 settings-schema.json 기본값)와 nginx-conf 를 그 자리에서 다시 읽은 것입니다.
              자세한 설명과 바꾸는 법은 <code className="font-mono">docs/port-map.md</code> 를 보세요.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
