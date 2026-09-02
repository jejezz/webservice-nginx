import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const MAP = {
  up: { label: '정상', variant: 'success', Icon: CheckCircle2 },
  degraded: { label: '주의', variant: 'warning', Icon: AlertTriangle },
  down: { label: '중단', variant: 'destructive', Icon: XCircle },
  unknown: { label: '알 수 없음', variant: 'secondary', Icon: HelpCircle },
};

export function StatusBadge({ status, className }) {
  const { label, variant, Icon } = MAP[status] || MAP.unknown;

  return (
    <Badge variant={variant} className={className}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}

export function StatusDot({ status }) {
  const color =
    status === 'up'
      ? 'bg-success'
      : status === 'degraded'
        ? 'bg-warning'
        : status === 'down'
          ? 'bg-destructive'
          : 'bg-muted-foreground';

  return (
    <span className="relative flex size-2.5">
      {status === 'up' && (
        <span className={`absolute inline-flex size-full animate-ping rounded-full ${color} opacity-60`} />
      )}
      <span className={`relative inline-flex size-2.5 rounded-full ${color}`} />
    </span>
  );
}
