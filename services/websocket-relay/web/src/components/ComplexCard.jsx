import { useCallback, useState } from 'react';
import { AlertCircle, AlertTriangle, Check, Copy, KeyRound, Loader2, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * 단지 ID 를 보여주고 바꾼다.
 *
 * ── 왜 값을 가리지 않는가 ────────────────────────────────────────
 * 이 값은 **비밀이 아니다.** 앱이 Firestore 디렉터리에서 공개로 받아 오는
 * 라우팅 키다 (`allow read: if true`). 게다가 서버는 앱이 이 필드를 아예
 * 안 보내면 자기 값으로 채우고 등록을 통과시킨다 — 값을 가려도 막히는 것이
 * 없다는 뜻이다.
 *
 * 가려 두면 보호되는 것 없이 "이건 비밀이구나" 라는 인상만 남고, 그러면 정작
 * 필요한 것(등록 시 1회용 토큰)을 만들지 않게 된다. 그래서 값은 그대로 보여
 * 주고 성격을 적어 둔다.
 *
 * ── 대신 무엇을 조이는가 ─────────────────────────────────────────
 * 위험한 것은 **바꾸는 쪽**이다. 바뀌는 순간 등록된 단말이 착신 대상 조회에서
 * 통째로 빠진다. 그래서 영향 대수를 먼저 보여 주고, 새 값을 두 번 입력받고,
 * 비밀번호를 다시 확인한다(확인은 서버가 manager 에 물어본다).
 */
export default function ComplexCard() {
  const { data, error, loading, reload } = usePolling(api.complex, 0);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    if (!data?.complexId) return;
    navigator.clipboard?.writeText(data.complexId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [data]);

  if (loading) return <Skeleton className="h-40" />;
  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error || '단지 정보를 불러오지 못했습니다.'}</AlertDescription>
      </Alert>
    );
  }

  const reg = data.registered;

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" />
            단지 ID
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil className="size-4" />
            변경
          </Button>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
              {data.complexId || '미설정'}
            </code>
            {data.complexId && (
              <Button variant="ghost" size="sm" onClick={copy} aria-label="복사">
                {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            등록과 착신 대상 조회가 이 값으로 걸러집니다.
            {data.complexId
              ? ' 앱은 이 값을 Firestore 단지 디렉터리에서 받아 옵니다.'
              : ' 비어 있어 단지 검사를 하지 않습니다 (단지가 하나뿐인 배치라면 정상).'}
          </p>

          {/*
            성격을 분명히 적어 둔다. 적어 두지 않으면 누군가 이걸 비밀로 착각해
            "가려야 하지 않나" 라는 이야기가 반복된다.
          */}
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">비밀이 아닙니다.</strong> 앱을 설치한 누구나 알 수 있는
            공개 라우팅 키입니다 — 오배송을 막는 안전망이지, "이 사람이 그 집 사람인가" 를
            가리지는 못합니다. 그건 별도의 1회용 등록 토큰이 필요합니다.
          </p>

          {reg && (
            <div className="grid grid-cols-3 gap-2 border-t pt-3 text-xs">
              <div>
                <p className="text-muted-foreground">이 단지 단말</p>
                <p className="font-mono text-sm">{reg.matching}</p>
              </div>
              <div>
                <p className="text-muted-foreground">다른 단지</p>
                <p className={`font-mono text-sm ${reg.orphaned > 0 ? 'text-destructive' : ''}`}>{reg.orphaned}</p>
              </div>
              <div>
                <p className="text-muted-foreground">접속 중</p>
                <p className="font-mono text-sm">{data.connectedWebsockets}</p>
              </div>
            </div>
          )}

          {reg?.orphaned > 0 && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>
                {reg.orphaned}대가 다른 단지 ID 로 등록되어 있습니다 — 그 단말들은 지금 착신
                대상 조회에서 빠져 전화를 받지 못합니다.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <ChangeDialog
        open={open}
        onOpenChange={setOpen}
        current={data}
        onSaved={reload}
      />
    </>
  );
}

function ChangeDialog({ open, onOpenChange, current, onSaved }) {
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const reg = current.registered;
  // 새 값이 지금과 다르면, 지금 이 단지로 등록된 단말이 전부 떨어져 나간다.
  const willOrphan = next.trim() !== '' && next.trim().toLowerCase() !== (current.complexId ?? '')
    ? (reg?.matching ?? 0)
    : 0;

  const reset = () => { setNext(''); setConfirm(''); setPassword(''); setError(''); };

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.updateComplex({ complexId: next.trim(), confirm: confirm.trim(), password });
      onOpenChange(false);
      reset();
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}
      className="max-w-md"
      labelledBy="complex-change-title"
    >
      <DialogClose onClick={() => { onOpenChange(false); reset(); }} />
      <DialogHeader>
        <DialogTitle id="complex-change-title">단지 ID 변경</DialogTitle>
        <DialogDescription>
          지금: <code className="font-mono">{current.complexId || '미설정'}</code>
        </DialogDescription>
      </DialogHeader>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {willOrphan > 0 && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle />
          <AlertDescription>
            등록된 <strong>{willOrphan}대</strong>가 즉시 착신 불가가 됩니다. 각 단말이 앱을
            열어 다시 등록하기 전까지 초인종·전화를 받지 못합니다.
            {current.connectedWebsockets > 0 && ` 지금 ${current.connectedWebsockets}개 연결이 열려 있습니다.`}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="c-next">새 단지 ID</Label>
          <Input
            id="c-next" value={next} onChange={(e) => setNext(e.target.value)}
            placeholder="a3f19c04" className="font-mono" autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            소문자 16진수 8자. 비우면 단지 검사를 끕니다. 생성: <code>openssl rand -hex 4</code>
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="c-confirm">한 번 더 입력</Label>
          <Input
            id="c-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="font-mono" autoComplete="off"
          />
          {/* 오타 하나가 단지 전체를 착신 불가로 만든다. 눈으로 두 번 보게 한다. */}
          <p className="text-xs text-muted-foreground">오타를 거르기 위한 확인입니다.</p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="c-password">내 manager 비밀번호</Label>
          <Input
            id="c-password" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
          />
          <p className="text-xs text-muted-foreground">
            로그인한 지 오래된 화면으로 실수하는 것을 막습니다. 확인은 서버가 manager 에
            물어봅니다.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { onOpenChange(false); reset(); }} disabled={saving}>
            취소
          </Button>
          <Button
            type="submit"
            variant={willOrphan > 0 ? 'destructive' : 'default'}
            disabled={saving || !password || confirm.trim().toLowerCase() !== next.trim().toLowerCase()}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {willOrphan > 0 ? `${willOrphan}대를 끊고 변경` : '변경'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
