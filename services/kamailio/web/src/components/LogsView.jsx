import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Pause, Play, RefreshCw, ScrollText, Terminal } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 로그 — 이 서비스는 pm2 가 아니라 **systemd** 가 띄우므로 로그가 저널에만
 * 있습니다. `pm2 logs` 로는 보이지 않아서, 터미널을 열지 않고도 볼 수 있게
 * 여기 둡니다.
 *
 * 읽기 전용입니다. 서버가 유닛 이름을 박아 두고 `journalctl` 을 읽기 인자만
 * 붙여 돌립니다 (lib/journal.js).
 */

const LINE_CHOICES = [100, 200, 500, 1000];
const WINDOW_CHOICES = [
  { label: '전체', minutes: 0 },
  { label: '10분', minutes: 10 },
  { label: '1시간', minutes: 60 },
  { label: '하루', minutes: 1440 },
];

/** 눈이 먼저 가야 할 줄에만 색을 준다. 전부 칠하면 아무것도 안 보인다. */
function toneOf(line) {
  if (/\b(ERR|ERROR|CRITICAL|FATAL|Failed|failed)\b/.test(line)) return 'text-destructive';
  if (/\b(WARN|WARNING|Warning)\b/.test(line)) return 'text-warning';
  return '';
}

export default function Logs({ unit, hint }) {
  const [lines, setLines] = useState(200);
  const [minutes, setMinutes] = useState(0);
  const [grep, setGrep] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [follow, setFollow] = useState(false);
  const [error, setError] = useState('');

  const boxRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await api.logs({ lines, minutes, grep: query });
      if (!mounted.current) return;
      setData(result);
      setError('');
    } catch (err) {
      if (mounted.current) setError(err.message || '로그를 불러오지 못했습니다.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [lines, minutes, query]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // 따라가기 — journalctl -f 대신 3초마다 다시 읽는다. 연결을 붙들지 않으므로
  // 창을 열어 둔 채 잊어도 서버에 남는 것이 없다.
  useEffect(() => {
    if (!follow) return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [follow, load]);

  // 새 줄이 오면 아래로 붙인다. 사람이 위로 올려 읽는 중이면 건드리지 않는다.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !follow) return;
    box.scrollTop = box.scrollHeight;
  }, [data, follow]);

  const shown = data?.lines ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="size-4" />
            로그
            <Badge variant="secondary" className="font-mono">
              systemd · {unit}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant={follow ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFollow((v) => !v)}
              title="3초마다 다시 읽습니다"
            >
              {follow ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              따라가기
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              새로 고침
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              {LINE_CHOICES.map((n) => (
                <Button
                  key={n}
                  variant={lines === n ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setLines(n)}
                >
                  {n}줄
                </Button>
              ))}
            </div>

            <span className="text-muted-foreground">·</span>

            <div className="flex items-center gap-1">
              {WINDOW_CHOICES.map((w) => (
                <Button
                  key={w.label}
                  variant={minutes === w.minutes ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setMinutes(w.minutes)}
                >
                  {w.label}
                </Button>
              ))}
            </div>

            <form
              className="flex flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(grep);
              }}
            >
              <Input
                value={grep}
                onChange={(e) => setGrep(e.target.value)}
                placeholder="필터 (정규식) — 예: SIP|register"
                className="h-7 flex-1 font-mono text-xs"
              />
              <Button type="submit" variant="outline" size="sm" className="h-7">
                거르기
              </Button>
            </form>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {data && !data.ok && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>저널을 읽지 못했습니다</AlertTitle>
              <AlertDescription className="space-y-2">
                <p className="font-mono text-xs">{data.error}</p>
                {data.denied && (
                  <p>
                    이 대시보드 프로세스에 저널 읽기 권한이 없습니다. 실행 계정을{' '}
                    <span className="font-mono">adm</span> 또는{' '}
                    <span className="font-mono">systemd-journal</span> 그룹에 넣고 pm2 를 다시 띄우세요.
                  </p>
                )}
                <pre className="rounded bg-muted/50 p-2 font-mono text-xs">
                  sudo usermod -aG systemd-journal $USER{'\n'}
                  pm2 kill && pm2 resurrect
                </pre>
              </AlertDescription>
            </Alert>
          )}

          <div
            ref={boxRef}
            className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3"
          >
            {loading && !shown.length ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                읽는 중…
              </div>
            ) : shown.length ? (
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                {shown.map((line, i) => (
                  <div key={i} className={toneOf(line)}>
                    {line}
                  </div>
                ))}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                {data?.filtered
                  ? '이 조건에 걸리는 줄이 없습니다. 필터나 기간을 넓혀 보세요.'
                  : '남아 있는 로그가 없습니다.'}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{shown.length}줄</span>
            <span className="font-mono">journalctl -u {unit} -n {lines}</span>
          </div>
        </CardContent>
      </Card>

      {hint}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="size-4" />
            터미널에서 보려면
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
            journalctl -u {unit} -f                  # 따라가기{'\n'}
            journalctl -u {unit} -n 200 --no-pager   # 최근 200줄{'\n'}
            journalctl -u {unit} --since "10 min ago"{'\n'}
            journalctl -u {unit} -p err --no-pager   # 오류만
          </pre>
          <p className="text-xs text-muted-foreground">
            이 서비스는 <strong>pm2 가 아니라 systemd</strong> 가 띄웁니다 — <span className="font-mono">pm2 logs</span> 에는
            나오지 않습니다. node 서비스들의 로그는 <span className="font-mono">pm2 logs &lt;이름&gt;</span> 이나{' '}
            <span className="font-mono">pm2/logs/*.log</span> 에 있습니다.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
