import { useCallback, useRef, useState } from 'react';
import {
  AlertCircle, AlertTriangle, BellRing, CheckCircle2, FileUp, Loader2, RefreshCw, ShieldAlert, Trash2, Upload,
} from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { InfoCard } from '@/components/InfoCard';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * FCM 서비스 계정 키 관리.
 *
 * ── 이 화면이 조심스러운 이유 ────────────────────────────────────
 * 이 키 하나가 "자고 있는 집의 전화를 울릴 수 있는가" 를 결정한다. 잘못 올리면
 * 서비스는 멀쩡해 보이고 대시보드도 초록색인데 착신만 조용히 죽는다. 그래서
 * 파일을 고른 즉시 서버에 **분석만** 시켜(`/firebase/analyze`, 파일을 건드리지
 * 않는다) 무슨 일이 벌어질지 먼저 보여 주고, 사람이 그걸 읽은 뒤에 적용한다.
 */

const SEVERITY = {
  error: { Icon: AlertCircle, cls: 'text-destructive', variant: 'destructive' },
  warn: { Icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-500', variant: 'default' },
  ok: { Icon: CheckCircle2, cls: 'text-emerald-600 dark:text-emerald-500', variant: 'default' },
};

function Findings({ findings }) {
  return (
    <ul className="space-y-2">
      {findings.map((f, i) => {
        const { Icon, cls } = SEVERITY[f.severity] ?? SEVERITY.ok;
        return (
          <li key={i} className="flex gap-2 text-sm">
            <Icon className={`mt-0.5 size-4 shrink-0 ${cls}`} />
            <div>
              <p>{f.message}</p>
              {f.hint && <p className="mt-0.5 text-xs text-muted-foreground">{f.hint}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function PushKey() {
  const { data, error, loading, refreshing, reload } = usePolling(api.firebase, 0);
  const [picked, setPicked] = useState(null); // { name, content, analysis }
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  const pick = useCallback(async (file) => {
    if (!file) return;
    setActionError('');
    setResult(null);
    setBusy('analyze');
    try {
      const content = await file.text();
      // 서버에 판단을 맡긴다 — 지금 쓰고 있는 키의 프로젝트를 알아야
      // "프로젝트가 바뀐다" 를 말할 수 있는데, 그건 서버만 안다.
      const analysis = await api.analyzeFirebase(content);
      setPicked({ name: file.name, content, analysis });
    } catch (err) {
      setActionError(err.message);
      setPicked(null);
    } finally {
      setBusy('');
    }
  }, []);

  const applyKey = useCallback(async () => {
    if (!picked) return;
    setBusy('install');
    setActionError('');
    try {
      const r = await api.installFirebase(picked.content);
      setResult(r);
      setPicked(null);
      if (inputRef.current) inputRef.current.value = '';
      reload();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy('');
    }
  }, [picked, reload]);

  const verify = useCallback(async () => {
    setBusy('verify');
    setActionError('');
    try {
      const r = await api.verifyFirebase();
      setResult({ live: r });
      reload();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy('');
    }
  }, [reload]);

  const removeKey = useCallback(async () => {
    if (!window.confirm(
      '설치된 FCM 키를 내립니다.\n\n' +
      '착신 푸시가 즉시 멈춥니다 — 앱이 떠 있지 않은 단말은 초인종·전화를 받지 못합니다.\n' +
      '(WebSocket 중계 자체는 계속 동작합니다. 지우기 전에 백업이 남습니다.)'
    )) return;
    setBusy('remove');
    setActionError('');
    try {
      await api.deleteFirebase();
      setResult(null);
      reload();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy('');
    }
  }, [reload]);

  if (loading) return <Skeleton className="h-72" />;
  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error || '상태를 불러오지 못했습니다.'}</AlertDescription>
      </Alert>
    );
  }

  const id = data.identity;
  const live = data.live ?? {};
  const modeOk = !data.mode || data.mode === '600';

  return (
    <>
      {(error || actionError) && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{actionError || error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">착신 푸시 키 (FCM)</h2>
          <p className="text-xs text-muted-foreground">
            Firebase 서비스 계정 키. 이 키로 자고 있는 단말을 깨웁니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            새로고침
          </Button>
          <Button variant="outline" size="sm" onClick={verify} disabled={!data.exists || busy !== ''}>
            {busy === 'verify' ? <Loader2 className="size-4 animate-spin" /> : <BellRing className="size-4" />}
            지금 확인
          </Button>
        </div>
      </div>

      {/* ── 지금 상태 ────────────────────────────────────── */}
      {!data.exists ? (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertDescription>
            키가 없어 <strong>착신 푸시가 꺼져 있습니다.</strong> 앱이 떠 있는 단말끼리는 통화가
            되지만, 자고 있는 단말은 초인종·전화를 받지 못합니다.
            {data.affectedDevices !== null && ` 지금 활성 단말 ${data.affectedDevices}대가 영향을 받습니다.`}
          </AlertDescription>
        </Alert>
      ) : !live.ok ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            키가 있지만 <strong>실제로는 통하지 않습니다</strong>{live.error ? `: ${live.error}` : '.'}
            {' '}서비스 계정이 삭제됐거나, 키가 회수됐거나, 서버 시계가 틀어졌거나, 바깥으로
            나가는 길이 막혀 있을 수 있습니다.
          </AlertDescription>
        </Alert>
      ) : null}

      {!modeOk && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            키 파일 권한이 <code>{data.mode}</code> 입니다 — <code>600</code> 이어야 합니다.
            같은 서버의 다른 계정이 이 키를 읽어 임의로 푸시를 보낼 수 있습니다.
          </AlertDescription>
        </Alert>
      )}

      <InfoCard
        title="설치된 키"
        rows={[
          ['상태', data.exists ? (live.ok ? '정상 동작' : '통하지 않음') : '없음'],
          ['Firebase 프로젝트', id?.projectId || '—', '등록 토큰이 이 프로젝트에 묶여 있습니다'],
          ['서비스 계정', id?.clientEmail || '—'],
          ['키 ID', id?.privateKeyId || '—', '개인키 자체가 아니라 그 식별자입니다'],
          ['알림 채널', data.channelId, '앱이 만들어 둔 채널. 소리와 중요도가 여기 묶여 있습니다'],
          ['파일', data.path],
          ['권한', data.mode || '—'],
          ['마지막 변경', data.modifiedAt ? formatDateTime(data.modifiedAt) : '—'],
          ['영향 받는 단말', data.affectedDevices === null ? '—' : `${data.affectedDevices}대 (활성)`],
        ]}
      />

      {result && (
        <Alert>
          <CheckCircle2 />
          <AlertDescription>
            {result.identity
              ? <>키를 적용했습니다 — 프로젝트 <strong>{result.identity.projectId}</strong>.{' '}
                {result.live?.ok ? '실제 발송 자격까지 확인했습니다.' : `다만 검증에 실패했습니다: ${result.live?.error}`}
                {result.backup && <> 이전 키는 <code>{result.backup}</code> 로 백업했습니다.</>}</>
              : result.live?.ok ? '확인했습니다 — 이 키로 푸시를 보낼 수 있습니다.'
              : `확인 실패: ${result.live?.error}`}
          </AlertDescription>
        </Alert>
      )}

      {/* ── 올리기 ───────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div>
            <h3 className="text-sm font-semibold">새 키 올리기</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Firebase 콘솔 → 프로젝트 설정 → <strong>서비스 계정</strong> → "새 비공개 키 생성" 으로
              받은 JSON 파일입니다. 일반 설정 탭의 SDK 스니펫이 아닙니다.
              올리면 서비스 재시작 없이 바로 반영되고, 이전 키는 백업됩니다.
            </p>
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}
            className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center"
          >
            <FileUp className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              JSON 파일을 끌어다 놓거나
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              onChange={(e) => pick(e.target.files?.[0])}
              className="hidden"
              id="key-file"
            />
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy !== ''}>
              {busy === 'analyze' ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              파일 선택
            </Button>
          </div>

          {/* 고른 파일의 분석 결과. 적용 전에 보여 준다. */}
          {picked && (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{picked.name}</span>
                <Badge variant={picked.analysis.usable ? 'default' : 'destructive'}>
                  {picked.analysis.usable ? '쓸 수 있음' : '쓸 수 없음'}
                </Badge>
              </div>

              <Findings findings={picked.analysis.findings} />

              {picked.analysis.projectChanges && data.affectedDevices > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertDescription>
                    지금 등록된 <strong>{data.affectedDevices}대</strong>의 토큰이 모두 무효가 됩니다.
                    각 단말이 앱을 열어 다시 등록하기 전까지 착신 푸시가 가지 않습니다.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setPicked(null)} disabled={busy !== ''}>
                  취소
                </Button>
                <Button
                  size="sm"
                  variant={picked.analysis.projectChanges ? 'destructive' : 'default'}
                  onClick={applyKey}
                  disabled={!picked.analysis.usable || picked.analysis.sameKey || busy !== ''}
                >
                  {busy === 'install' ? <Loader2 className="size-4 animate-spin" /> : null}
                  {picked.analysis.projectChanges ? '프로젝트를 바꾸며 적용' : '적용'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {data.exists && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={removeKey} disabled={busy !== ''}>
            <Trash2 className="size-4 text-destructive" />
            키 내리기 (푸시 끄기)
          </Button>
        </div>
      )}
    </>
  );
}
