import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import { StatusBadge, StatusDot } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatLatency, formatTime, formatUptime } from '@/lib/format';
import { cn } from '@/lib/utils';

function Pm2Cell({ pm2 }) {
  if (!pm2) return <span className="text-muted-foreground">—</span>;

  const online = pm2.status === 'online';

  return (
    <div className="flex items-center gap-2">
      <Badge variant={online ? 'success' : 'destructive'}>{pm2.status}</Badge>
      {online && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {pm2.cpu ?? 0}% · {pm2.memoryMb ?? 0}MB
        </span>
      )}
    </div>
  );
}

function DetailRow({ service }) {
  const { health, pm2, target } = service;

  const items = [
    ['Health URL', service.healthUrl || '—'],
    ['등록 위치', (service.sources || []).map((s) => (s === 'nginx' ? 'nginx-conf' : 'pm2-conf')).join(' + ') || '—'],
    ['Nginx location', service.location || '— (라우트 없음)'],
    ['proxy_pass', service.proxyPass || '—'],
    ['WebSocket', service.websocket ? '사용' : '미사용'],
    ['대상 호스트', target ? `${target.host}:${target.port}` : '—'],
    ['HTTP 상태', health.httpStatus ?? '—'],
    ['응답 시간', formatLatency(health.latencyMs)],
    ['마지막 확인', formatTime(health.checkedAt)],
  ];

  if (pm2) {
    items.push(
      ['PM2 PID', pm2.pid ?? '—'],
      ['PM2 가동 시간', formatUptime(pm2.uptimeSec)],
      ['PM2 재시작 횟수', pm2.restarts],
    );
  }

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={7} className="p-0">
        <div className="space-y-4 p-5">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {items.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="truncate font-mono text-xs">{String(value)}</dd>
              </div>
            ))}
          </dl>

          {health.error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
              {health.error}
            </p>
          )}

          {health.body && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">/health 응답</p>
              <pre className="max-h-56 overflow-auto rounded-md border bg-background p-3 font-mono text-xs">
                {typeof health.body === 'string' ? health.body : JSON.stringify(health.body, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ServiceTable({ services, onRecheck, rechecking }) {
  const [expanded, setExpanded] = useState(() => new Set());

  function toggle(name) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  if (services.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        nginx-conf에 정의된 라우트가 없습니다.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10" />
          <TableHead>서비스</TableHead>
          <TableHead>상태</TableHead>
          <TableHead className="hidden md:table-cell">Location</TableHead>
          <TableHead className="hidden lg:table-cell">대상</TableHead>
          <TableHead className="hidden sm:table-cell">PM2</TableHead>
          <TableHead className="text-right">응답</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {services.map((service) => {
          const open = expanded.has(service.name);

          return [
            <TableRow
              key={service.name}
              className={cn('cursor-pointer', open && 'bg-muted/30')}
              onClick={() => toggle(service.name)}
            >
              <TableCell className="pr-0">
                {open ? (
                  <ChevronDown className="size-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" />
                )}
              </TableCell>

              <TableCell>
                <div className="flex items-center gap-2.5">
                  <StatusDot status={service.health.status} />
                  <div>
                    <div className="font-medium">{service.name}</div>
                    <div className="text-xs text-muted-foreground md:hidden">
                      {service.location || (service.target ? `:${service.target.port}` : '—')}
                    </div>
                  </div>
                  {service.websocket && (
                    <Badge variant="outline" className="hidden sm:inline-flex">
                      WS
                    </Badge>
                  )}
                  {!service.location && (
                    <Badge variant="secondary" className="hidden sm:inline-flex" title="nginx 라우트 없이 포트로 직접 접근">
                      직결
                    </Badge>
                  )}
                </div>
              </TableCell>

              <TableCell>
                <StatusBadge status={service.health.status} />
              </TableCell>

              <TableCell className="hidden font-mono text-xs md:table-cell">
                {service.location || <span className="text-muted-foreground">—</span>}
              </TableCell>

              <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                {service.target ? `${service.target.host}:${service.target.port}` : '—'}
              </TableCell>

              <TableCell className="hidden sm:table-cell">
                <Pm2Cell pm2={service.pm2} />
              </TableCell>

              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {formatLatency(service.health.latencyMs)}
                  </span>
                  {/* 자체 대시보드를 구현한 서비스만 링크를 노출한다 */}
                  {service.dashboardUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      asChild
                      onClick={(e) => e.stopPropagation()}
                    >
                      <a href={service.dashboardUrl} title={`${service.name} 대시보드 열기`}>
                        <ExternalLink className="size-3.5" />
                        <span className="hidden lg:inline">대시보드</span>
                      </a>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    title="다시 확인"
                    disabled={rechecking === service.name}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRecheck(service.name);
                    }}
                  >
                    <RefreshCw className={cn('size-3.5', rechecking === service.name && 'animate-spin')} />
                  </Button>
                </div>
              </TableCell>
            </TableRow>,

            open && <DetailRow key={`${service.name}-detail`} service={service} />,
          ];
        })}
      </TableBody>
    </Table>
  );
}
