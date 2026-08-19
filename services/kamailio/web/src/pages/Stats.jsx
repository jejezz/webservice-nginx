import { useState } from 'react';
import { AlertCircle, BarChart3, RefreshCw, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/** 먼저 보고 싶은 그룹. 나머지는 그 아래에 이름순으로 붙는다. */
const PRIORITY = ['core', 'shmem', 'registrar', 'usrloc', 'tmx', 'sl', 'websocket'];

export default function Stats() {
  const { data, error, loading, refreshing, reload } = usePolling(api.stats, 5000);
  const [filter, setFilter] = useState('');

  if (loading) return <Skeleton className="h-64" />;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const groups = data.groups || {};
  const names = Object.keys(groups).sort((a, b) => {
    const ia = PRIORITY.indexOf(a);
    const ib = PRIORITY.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });

  const q = filter.trim().toLowerCase();
  const visible = names
    .map((name) => {
      const entries = Object.entries(groups[name]).filter(
        ([k]) => !q || name.toLowerCase().includes(q) || k.toLowerCase().includes(q)
      );
      return [name, entries];
    })
    .filter(([, entries]) => entries.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="통계 이름으로 거르기 (예: register, shmem)"
            className="pl-8"
          />
        </div>
        <span className="text-xs text-muted-foreground">{formatTime(data.updatedAt)}</span>
        <Button variant="ghost" size="sm" onClick={reload} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
      </div>

      {visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">일치하는 통계가 없습니다.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map(([name, entries]) => (
            <Card key={name}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <BarChart3 className="size-3.5" />
                  {name}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 gap-y-1">
                  {entries.map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1">
                      <dt className="shrink-0 text-xs text-muted-foreground">{k}</dt>
                      <dd className="font-mono text-xs tabular-nums">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
