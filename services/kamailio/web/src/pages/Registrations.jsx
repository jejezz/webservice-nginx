import { AlertCircle, RefreshCw, Radio } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** 전송 방식별 배지. WS 단말과 UDP 단말을 한눈에 구분하려는 것이 목적이다. */
const TRANSPORT = {
  ws: { text: 'WS', variant: 'success' },
  wss: { text: 'WSS', variant: 'success' },
  tcp: { text: 'TCP', variant: 'secondary' },
  udp: { text: 'UDP', variant: 'outline' },
};

export default function Registrations() {
  const { data, error, loading, refreshing, reload } = usePolling(api.registrations, 5000);

  if (loading) return <Skeleton className="h-64" />;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const rows = data.registrations || [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className="size-4" />
          등록 단말
          <Badge variant="outline" className="ml-1 font-normal">{rows.length}</Badge>
        </CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{formatTime(data.updatedAt)}</span>
          <Button variant="ghost" size="sm" onClick={reload} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-muted-foreground">등록된 단말이 없습니다.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              단말이 REGISTER 에 성공하면 여기에 나타납니다.
              {' '}인증이 막히면 SIP 계정 탭의 도메인 경고를 확인하세요.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>AoR</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>전송</TableHead>
                <TableHead>만료</TableHead>
                <TableHead>User-Agent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const t = TRANSPORT[r.transport] || TRANSPORT.udp;
                return (
                  <TableRow key={`${r.aor}-${i}`}>
                    <TableCell className="font-mono text-xs">{r.aor}</TableCell>
                    <TableCell className="max-w-xs truncate font-mono text-xs" title={r.contact}>
                      {r.contact || '—'}
                    </TableCell>
                    <TableCell><Badge variant={t.variant} className="font-normal">{t.text}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{r.expires ?? '—'}</TableCell>
                    <TableCell className="max-w-[12rem] truncate text-xs text-muted-foreground" title={r.userAgent}>
                      {r.userAgent || '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {data.raw?.length > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            usrloc 도메인: {data.raw.map((d) => `${d.domain} (${d.records}건)`).join(', ')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
