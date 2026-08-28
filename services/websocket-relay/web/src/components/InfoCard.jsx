import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** 라벨-값 목록을 보여주는 카드. 대시보드 전반에서 재사용한다. */
export function InfoCard({ title, Icon, action, rows, columns = 2, className }) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          {Icon && <Icon className="size-4" />}
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent>
        <dl className={cn('grid grid-cols-1 gap-x-8 gap-y-1', columns === 2 && 'sm:grid-cols-2')}>
          {rows.map(([label, value, hint]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5">
              <dt className="shrink-0 text-xs text-muted-foreground" title={hint}>
                {label}
              </dt>
              <dd className="truncate font-mono text-xs" title={typeof value === 'string' ? value : undefined}>
                {value === null || value === undefined || value === '' ? '—' : value}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function StatTile({ label, value, hint, tone = 'default' }) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    destructive: 'text-destructive',
  }[tone];

  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-semibold tabular-nums', toneClass)}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
