import { AlertCircle, Globe, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function WebSockets() {
  const { data, error, loading, refreshing, reload } = usePolling(api.websockets, 5000);

  if (loading) return <Skeleton className="h-64" />;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const conns = data.connections || [];

  return (
    <div className="space-y-4">
      {data.truncated && (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertDescription>
            목록이 잘렸습니다. 연결이 많아 Kamailio 가 일부만 돌려주었습니다.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="size-4" />
            WebSocket 연결
            <Badge variant="outline" className="ml-1 font-normal">{data.count}</Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{formatTime(data.updatedAt)}</span>
            <Button variant="ghost" size="sm" onClick={reload} disabled={refreshing}>
              <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {conns.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-muted-foreground">WebSocket 연결이 없습니다.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                단말이 <code className="font-mono">wss://&lt;공인IP&gt;:28443/sip/</code> 로 붙으면 여기에 나타납니다.
              </p>
            </div>
          ) : (
            // ws.dump 의 연결 항목은 Kamailio 버전에 따라 필드가 달라, 있는 것을 그대로 보여준다.
            <div className="space-y-2">
              {conns.map((c, i) => (
                <div key={i} className="rounded-md border p-3">
                  <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
                    {Object.entries(c).map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1">
                        <dt className="shrink-0 text-xs text-muted-foreground">{k}</dt>
                        <dd className="truncate font-mono text-xs" title={String(v)}>{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
