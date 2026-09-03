import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Pencil, Radio, Wand2 } from 'lucide-react';
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
 * 앱이 REGISTER 를 보낼 이 단지의 Kamailio 주소를 보여주고 바로잡는다.
 *
 * ── 단지 ID 와 다른 점 ───────────────────────────────────────────
 * 이 값을 바꾼다고 Kamailio 서버가 바뀌지는 않는다 — 서버가 앱에게 알려
 * 주는 주소만 고칠 뿐이다. 그래서 재입력 확인·비밀번호 재확인을 요구하지
 * 않는다: 잘못 고쳐도 결과는 "다음 등록이 옛 값으로 붙는다" 뿐이고, 그마저
 * 바로 여기서 다시 고치면 그만이다. (ComplexCard.jsx 참고)
 *
 * ── 대개는 손댈 일이 없다 ────────────────────────────────────────
 * Kamailio 와 Janus 는 반드시 한 PC 에 설치되므로, 서버가 Kamailio
 * settings.ini 또는 이 장비의 LAN IP 에서 자동으로 찾는다(`detected`).
 * `value` 가 비어 있으면 그 감지값을 그대로 쓰고 있다는 뜻이다 — 이 화면은
 * 감지가 틀렸을 때만 쓴다.
 */
export default function SipProxyCard() {
  const { data, error, loading, reload } = usePolling(api.sipProxy, 0);
  const [open, setOpen] = useState(false);

  if (loading) return <Skeleton className="h-32" />;
  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error || 'SIP 프록시 정보를 불러오지 못했습니다.'}</AlertDescription>
      </Alert>
    );
  }

  const effective = data.value || data.detected;
  const mismatched = data.value && data.detected && data.value !== data.detected;

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="size-4" />
            SIP 프록시
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil className="size-4" />
            변경
          </Button>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
              {effective || '미설정'}
            </code>
            {!data.overridden && effective && (
              <span className="text-xs text-muted-foreground">자동 감지</span>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            앱이 인터폰 내선(SIP)에 REGISTER 를 보낼 Kamailio 주소입니다. 등록 응답의
            <code className="mx-1">sip.proxy</code>로 나갑니다. Kamailio 서버 자체를 바꾸지는
            않습니다 — 여기서는 앱에게 알려 줄 주소만 고칩니다.
          </p>

          {!effective && (
            <p className="text-xs text-muted-foreground">
              감지하지 못했습니다 — 등록 응답에 <code>sip.proxy</code>를 싣지 않고, 앱은 빌드
              시점 기본값을 씁니다.
            </p>
          )}

          {mismatched && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>
                지금 값이 감지된 값과 다릅니다 ({data.value} ≠ {data.detected}). 의도적으로
                고친 값이 아니라면 확인하세요.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <ChangeDialog open={open} onOpenChange={setOpen} current={data} onSaved={reload} />
    </>
  );
}

function ChangeDialog({ open, onOpenChange, current, onSaved }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // 열릴 때마다 지금 값으로 되돌린다 — 이전에 취소한 입력이 남지 않게.
  useEffect(() => {
    if (open) {
      setValue(current.value ?? '');
      setError('');
    }
  }, [open, current.value]);

  async function save(next) {
    setError('');
    setSaving(true);
    try {
      await api.updateSipProxy(next);
      onOpenChange(false);
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
      onOpenChange={(v) => { onOpenChange(v); if (!v) setError(''); }}
      className="max-w-md"
      labelledBy="sip-proxy-change-title"
    >
      <DialogClose onClick={() => onOpenChange(false)} />
      <DialogHeader>
        <DialogTitle id="sip-proxy-change-title">SIP 프록시 변경</DialogTitle>
        <DialogDescription>
          지금: <code className="font-mono">{current.value || '미설정 (자동 감지 사용 중)'}</code>
        </DialogDescription>
      </DialogHeader>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={(e) => { e.preventDefault(); save(value.trim()); }} className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="sp-value">새 SIP 프록시</Label>
          <Input
            id="sp-value" value={value} onChange={(e) => setValue(e.target.value)}
            placeholder="sip:10.10.0.224:5060" className="font-mono" autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            <code>sip:&lt;Kamailio 주소&gt;:&lt;포트&gt;</code> 형식입니다. 비우면 자동 감지로
            되돌립니다.
          </p>
        </div>

        {current.detected && current.detected !== value.trim() && (
          <Button
            type="button" variant="ghost" size="sm"
            className="w-fit"
            onClick={() => setValue(current.detected)}
            disabled={saving}
          >
            <Wand2 className="size-4" />
            감지된 값 쓰기 ({current.detected})
          </Button>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            취소
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            저장
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
