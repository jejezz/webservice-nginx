import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  HelpCircle,
  ListChecks,
  Loader2,
  Lock,
  MinusCircle,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth';
import { formatTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * 구축 마법사 — 설계는 docs/setup-wizard.md 에 있습니다.
 *
 * 진행 상태는 **점검 결과로만** 정해집니다. 사람이 누른 "했습니다" 는 점검을
 * 부르는 방아쇠일 뿐이고, 그 결과가 다음 단계의 문을 엽니다.
 */

// 점검하지 않은 단계와 점검했으나 알 수 없는 단계를 구분한다.
// 둘 다 통과가 아니지만, 뒤엣것은 "돌렸는데 읽지 못했다" 는 뜻이다.
const STATE_STYLE = {
  complete: { label: '통과', badge: 'success', Icon: CheckCircle2, tone: 'text-success' },
  incomplete: { label: '아직', badge: 'warning', Icon: Circle, tone: 'text-warning' },
  problem: { label: '문제', badge: 'destructive', Icon: XCircle, tone: 'text-destructive' },
  unknown: { label: '확인 못함', badge: 'secondary', Icon: HelpCircle, tone: 'text-muted-foreground' },
};

const NOT_CHECKED = { label: '점검 전', badge: 'outline', Icon: Circle, tone: 'text-muted-foreground' };

function styleOf(step) {
  if (!step.result) return NOT_CHECKED;
  return STATE_STYLE[step.result.state] || STATE_STYLE.unknown;
}

// docs/check-contract.md 의 네 레벨. skip 과 pending 은 터미널에서 둘 다 [--] 로
// 보이지만 판정이 다르다 — 화면에서는 그것을 갈라 보여 준다.
const LEVEL_STYLE = {
  ok: { mark: '[ok]', tone: 'text-success', note: '' },
  skip: { mark: '[--]', tone: 'text-muted-foreground', note: '안 해도 되는 것' },
  pending: { mark: '[--]', tone: 'text-warning', note: '아직 안 한 것' },
  problem: { mark: '[!!]', tone: 'text-destructive', note: '문제' },
};

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드를 쓸 수 없으면 사용자가 직접 고를 수 있게 그대로 둔다.
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? '복사됨' : '명령 복사'}
    </Button>
  );
}

function CheckLines({ result }) {
  if (!result) return null;

  if (result.error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>
          {result.error}
          {result.stderr && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs opacity-80">{result.stderr}</pre>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (result.checks.length === 0) {
    return <p className="text-xs text-muted-foreground">점검 항목이 없습니다.</p>;
  }

  return (
    <ul className="space-y-1">
      {result.checks.map((check, i) => {
        const style = LEVEL_STYLE[check.level] || LEVEL_STYLE.problem;
        return (
          <li key={`${check.level}-${i}`} className="flex items-baseline gap-2 font-mono text-xs">
            <span className={cn('shrink-0 font-semibold', style.tone)}>{style.mark}</span>
            {/* 점검 문구는 칸을 띄워 열을 맞춘 것이 있다 (패키지명 | 설명). 그 공백을 살린다. */}
            <span className={cn('whitespace-pre-wrap', check.level === 'skip' && 'text-muted-foreground')}>{check.text}</span>
            {style.note && check.level !== 'ok' && (
              <span className="shrink-0 text-[10px] text-muted-foreground">— {style.note}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StepDetail({ step, onCheck, running }) {
  const style = styleOf(step);
  const blocked = step.blockedBy.length > 0;
  const result = step.result;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-base">{step.title}</CardTitle>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{step.id}</p>
        </div>
        <Badge variant={style.badge}>{style.label}</Badge>
      </CardHeader>

      <CardContent className="space-y-5">
        <section>
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">왜 필요한가</h3>
          <p className="text-sm leading-relaxed">{step.why}</p>
        </section>

        {blocked && (
          <Alert>
            <Lock />
            <AlertDescription>
              앞 단계가 아직 통과하지 않았습니다: <span className="font-mono">{step.blockedBy.join(', ')}</span>
              <br />
              순서를 뒤집으면 조용히 깨집니다. 그래도 점검만은 지금 돌려 볼 수 있습니다.
            </AlertDescription>
          </Alert>
        )}

        <section>
          <div className="mb-1 flex items-center justify-between gap-4">
            <h3 className="text-xs font-semibold text-muted-foreground">
              실행할 것 {step.command.sudo && <span className="font-normal">— 터미널에서 직접 (마법사는 sudo 를 부르지 않습니다)</span>}
            </h3>
            <CopyButton text={`cd ${step.command.cwd}\n${step.command.run}`} />
          </div>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {`cd ${step.command.cwd}\n${step.command.run}`}
          </pre>
        </section>

        <Separator />

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button onClick={() => onCheck(step.id)} disabled={running}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <ListChecks className="size-4" />}
              {result ? '다시 점검하기' : '했습니다 — 점검하기'}
            </Button>
            <p className="font-mono text-xs text-muted-foreground">
              {step.checkCwd}/{step.checkCommand.replace('./', '')}
            </p>
          </div>

          {result && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>점검 {formatTime(result.ranAt)}</span>
                <span>·</span>
                <span>{result.durationMs} ms</span>
                <span>·</span>
                <span>종료 코드 {result.exitCode ?? '—'}</span>
              </div>

              <CheckLines result={result} />

              {result.state === 'complete' && (
                <p className="text-xs text-success">통과했습니다. 다음 단계가 열렸습니다.</p>
              )}
              {result.state === 'incomplete' && (
                <p className="text-xs text-warning">
                  아직 통과하지 못했습니다. 위의 <span className="font-mono">[--] 아직 안 한 것</span> 을 마저 하세요.
                </p>
              )}
              {result.state === 'problem' && (
                <p className="text-xs text-destructive">
                  아직 통과하지 못했습니다. 위의 <span className="font-mono">[!!]</span> 를 해결하세요.
                </p>
              )}
              {result.state === 'unknown' && (
                <p className="text-xs text-muted-foreground">
                  점검을 마치지 못했으므로 통과로 두지 않습니다. 터미널에서 같은 명령을 직접 돌려 보세요.
                </p>
              )}
            </>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

export default function Setup() {
  const { user, logout } = useAuth();

  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [running, setRunning] = useState(null); // 점검 중인 단계 id, 또는 'all'
  const [error, setError] = useState('');

  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const handleError = useCallback(
    async (err) => {
      if (err instanceof ApiError && err.status === 401) {
        await logout();
        return;
      }
      if (mounted.current) setError(err.message || '점검을 실행하지 못했습니다.');
    },
    [logout]
  );

  const refresh = useCallback(async () => {
    const result = await api.setup.overview();
    if (!mounted.current) return null;
    setData(result);
    setSelected((prev) => prev || result.steps[0]?.id || null);
    return result;
  }, []);

  const checkOne = useCallback(
    async (stepId) => {
      setRunning(stepId);
      try {
        await api.setup.check(stepId);
        // 잠금 판정은 서버가 갖고 있는 마지막 결과에서 나온다. 한 곳에서만
        // 계산하도록 점검한 뒤 전체를 다시 읽는다 (자식 프로세스는 돌지 않는다).
        await refresh();
        setError('');
      } catch (err) {
        await handleError(err);
      } finally {
        if (mounted.current) setRunning(null);
      }
    },
    [handleError, refresh]
  );

  // 마법사에 들어오면 모든 단계를 한 번 점검해 어디까지 됐는지 먼저 보여 준다.
  // 처음 세우는 사람과 이미 세운 사람이 같은 화면을 쓴다.
  const checkAll = useCallback(async () => {
    setRunning('all');
    try {
      const overview = await refresh();
      if (!overview) return;

      for (const step of overview.steps) {
        if (!mounted.current) return;
        if (step.manualOnly) continue;
        await api.setup.check(step.id).catch(() => null);
        await refresh();
      }
      setError('');
    } catch (err) {
      await handleError(err);
    } finally {
      if (mounted.current) setRunning(null);
    }
  }, [handleError, refresh]);

  useEffect(() => {
    checkAll();
    // 처음 한 번만. 이후 점검은 사람이 누를 때 돈다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = data?.steps.find((s) => s.id === selected) || null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" asChild title="대시보드로">
              <Link to="/dashboard">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <div>
              <h1 className="text-sm font-semibold leading-tight">구축 마법사</h1>
              <p className="text-xs text-muted-foreground">
                {data ? `${data.complete} / ${data.total} 단계 통과` : '불러오는 중…'}
                {data?.updatedAt ? ` · 갱신 ${formatTime(data.updatedAt)}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            <Button variant="outline" size="sm" onClick={checkAll} disabled={Boolean(running)}>
              <RefreshCw className={cn('size-3.5', running === 'all' && 'animate-spin')} />
              <span className="hidden sm:inline">전체 점검</span>
            </Button>
            <div className="hidden text-right md:block">
              <p className="text-xs font-medium leading-tight">{user?.displayName}</p>
              <p className="text-xs text-muted-foreground">{user?.username}</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!data ? (
          <div className="space-y-6">
            <Skeleton className="h-20" />
            <Skeleton className="h-80" />
          </div>
        ) : (
          <>
            <Card>
              <CardContent className="flex flex-wrap gap-2 p-3">
                {data.steps.map((step, i) => {
                  const style = styleOf(step);
                  const Icon = step.blockedBy.length > 0 && step.result?.state !== 'complete' ? Lock : style.Icon;
                  const active = step.id === selected;

                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => setSelected(step.id)}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors',
                        active ? 'border-primary bg-accent' : 'hover:bg-accent/50'
                      )}
                    >
                      {running === step.id ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <Icon className={cn('size-4 shrink-0', style.tone)} />
                      )}
                      <span className="font-medium">
                        {i + 1}. {step.title}
                      </span>
                    </button>
                  );
                })}
              </CardContent>
            </Card>

            {current && (
              <StepDetail step={current} onCheck={checkOne} running={running === current.id || running === 'all'} />
            )}

            <div className="space-y-1 pb-4 text-center text-xs text-muted-foreground">
              <p>
                통과 여부는 각 점검 스크립트의 <code className="font-mono">--json</code> 출력으로만 정합니다
                (<code className="font-mono">docs/check-contract.md</code>).
              </p>
              <p>
                <MinusCircle className="mr-1 inline size-3" />
                <span className="font-mono">[--]</span> 은 터미널에서 한 가지로 보이지만 여기서는
                <span className="text-muted-foreground"> 안 해도 되는 것</span> 과
                <span className="text-warning"> 아직 안 한 것</span> 으로 갈라집니다.
              </p>
              <p>마법사는 sudo 를 부르지 않습니다 — 바꾸는 명령은 사람이 터미널에서 돌립니다.</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
