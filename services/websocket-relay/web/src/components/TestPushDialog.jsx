import { useEffect, useState } from 'react';
import { AlertCircle, BellRing, CheckCircle2, SearchCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toKorean } from '@/lib/address';

/**
 * 단말 한 대에 시험 푸시를 보내고 결과를 보여 준다.
 *
 * ── 왜 두 개의 버튼인가 ─────────────────────────────────────────
 * 확인하고 싶은 것이 상황마다 다르다.
 *
 *   토큰 검증만  구글에 "이 토큰으로 보낼 수 있는가" 만 묻는다. 단말은
 *                조용하고 DB 도 그대로다. 새벽에, 또는 남의 집 폰을 울리지
 *                않고 죽은 토큰을 골라낼 때 쓴다.
 *   실제 발송    진짜로 보낸다. **이것만이** 마지막 한 겹(앱이 알림을
 *                띄우는가)에 답한다 — 토큰이 유효해도 앱이 채널을 안 만들었거나
 *                알림 권한이 꺼져 있으면 조용하고, 그건 서버에서 보이지 않는다.
 *
 * 실제 발송은 다른 발송과 같은 규칙으로 기록된다. 무효 토큰이면 그 자리에서
 * 비활성으로 내려가므로, 결과를 받은 뒤 목록을 다시 읽는다.
 */
export default function TestPushDialog({ open, record, onOpenChange, onChanged }) {
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  // 다른 단말로 열 때 앞 단말의 결과가 남아 있으면 그 단말의 결과로 읽힌다.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError('');
    setBusy('');
  }, [open, record?.id]);

  if (!record) return null;

  async function send(dryRun) {
    setBusy(dryRun ? 'dry' : 'send');
    setResult(null);
    setError('');
    try {
      const r = await api.testPush(record.id, dryRun);
      setResult(r);
      // 활성 여부·실패 표시가 바뀌었을 수 있다.
      if (!dryRun && (r.deactivated || r.recovered || !r.ok)) onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} labelledBy="test-push-title" className="max-w-md">
      <DialogClose onClick={() => onOpenChange(false)} />
      <DialogHeader>
        <DialogTitle id="test-push-title" className="flex items-center gap-2">
          <BellRing className="size-4" /> 시험 푸시
        </DialogTitle>
        <DialogDescription>
          {toKorean(record.address)} · {record.email}
        </DialogDescription>
      </DialogHeader>

      <p className="text-xs leading-relaxed text-muted-foreground">
        <strong>토큰 검증만</strong> 은 구글에 물어보기만 합니다 — 단말에 알림이 뜨지 않고
        기록도 바뀌지 않습니다. <strong>실제 발송</strong> 은 그 단말에 알림을 띄웁니다.
        앱이 알림을 실제로 띄우는지는 이쪽으로만 확인할 수 있습니다.
      </p>

      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <Alert variant={result.ok ? undefined : 'destructive'} className="mt-4">
          {result.ok ? <CheckCircle2 /> : <AlertCircle />}
          <AlertDescription className="space-y-1">
            <div>
              {result.ok
                ? (result.delivered
                    ? '발송했습니다. 단말에 알림이 떴는지 확인하세요 — 뜨지 않으면 서버가 아니라 앱 쪽(알림 채널·권한)입니다.'
                    : '토큰이 유효합니다. 단말에는 아무것도 보내지 않았습니다.')
                : '보내지 못했습니다.'}
            </div>
            {result.code && <div className="font-mono text-xs">{result.code}</div>}
            {result.message && <div className="text-xs opacity-80">{result.message}</div>}
            {result.hint && <div className="text-xs">→ {result.hint}</div>}
            {result.deactivated && (
              <div className="text-xs">FCM 이 모르는 토큰이라 이 단말을 비활성으로 내렸습니다.</div>
            )}
            {result.recovered && (
              <div className="text-xs">예전 실패 표시를 지웠습니다.</div>
            )}
            {/*
              성공했는데 단말이 비활성인 경우. 푸시는 닿지만 착신 대상 조회는
              active = 1 만 뽑으므로 초인종은 여전히 이 단말을 부르지 않는다.
              서버가 알아서 켜지는 않는다 — 사람이 끈 것일 수도 있어서다.
            */}
            {result.ok && !record.active && (
              <div className="text-xs">
                이 단말은 <strong>비활성</strong>입니다. 푸시는 닿지만 착신 대상에서는 빠져 있으니,
                되살리려면 표에서 '활성' 을 켜세요.
              </div>
            )}
            {result.messageId && <div className="font-mono text-[10px] opacity-70">{result.messageId}</div>}
          </AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>닫기</Button>
        <Button variant="outline" disabled={Boolean(busy)} onClick={() => send(true)}>
          <SearchCheck className="size-4" />
          {busy === 'dry' ? '확인 중…' : '토큰 검증만'}
        </Button>
        <Button disabled={Boolean(busy)} onClick={() => send(false)}>
          <BellRing className="size-4" />
          {busy === 'send' ? '보내는 중…' : '실제 발송'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
