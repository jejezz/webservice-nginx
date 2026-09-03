import { useCallback, useState } from 'react';
import { AlertCircle, BellRing, Check, Clock, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toKorean } from '@/lib/address';

/**
 * 승인 대기 중인 등록 요청.
 *
 * ── 왜 맨 위에 있는가 ────────────────────────────────────────────
 * 여기 있는 요청은 **아무 권한이 없다.** 사람이 승인해야 전화를 받거나 집을
 * 제어할 수 있다. 즉 이 목록이 비어 있지 않다는 것은 "누군가 기다리고 있다"
 * 는 뜻이고, 방치하면 그 사람에게는 그냥 고장으로 보인다.
 *
 * 정상 경로는 **댁내 월패드**에서 승인하는 것이다. 이 화면은 월패드가
 * 고장났거나 관리자가 대신 처리해야 할 때 쓴다 — 그래서 눈에 띄되, 월패드
 * 쪽이 정상 경로임을 적어 둔다.
 */
export default function PendingEnrollments({ address, onApproved }) {
  // 30초마다 갱신한다. 대기는 30분이면 사라지므로 오래된 화면을 들고 있을
  // 이유가 없고, 월패드에서 승인되면 여기서도 사라져야 한다.
  const { data, error, reload } = usePolling(
    useCallback(() => api.enrollments(address), [address]), 30000);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState('');
  // 행마다 무엇을 열어 줄지. 기본은 둘 다 꺼짐이다.
  const [grants, setGrants] = useState({});

  const grantOf = (id) => grants[id] ?? { canCall: false, canControl: false };
  const setGrant = (id, patch) =>
    setGrants((g) => ({ ...g, [id]: { ...grantOf(id), ...patch } }));

  const act = useCallback(async (id, fn) => {
    setBusy(id);
    setActionError('');
    try {
      await fn();
      reload();
      onApproved?.();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(null);
    }
  }, [reload, onApproved]);

  const records = data?.records ?? [];
  if (records.length === 0) return null;

  const limits = data?.limits;

  return (
    <Card className="border-amber-500/40">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BellRing className="size-4 text-amber-600 dark:text-amber-500" />
            <h3 className="text-sm font-semibold">승인 대기 {records.length}건</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            정상 경로는 <strong>댁내 월패드</strong>에서 승인하는 것입니다.
            {limits && ` 요청은 ${limits.ttlMinutes}분 뒤 사라집니다.`}
          </p>
        </div>

        {(error || actionError) && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{actionError || error}</AlertDescription>
          </Alert>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>세대</TableHead>
                <TableHead>이메일</TableHead>
                <TableHead>기기</TableHead>
                <TableHead>요청</TableHead>
                <TableHead className="text-center">통화</TableHead>
                <TableHead className="text-center">제어</TableHead>
                <TableHead className="text-right">처리</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => {
                const g = grantOf(r.id);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs" title={r.address}>
                      {toKorean(r.address)}
                    </TableCell>
                    <TableCell className="text-xs">{r.email}</TableCell>
                    <TableCell className="max-w-48 truncate text-xs text-muted-foreground" title={`${r.user_agent ?? ''}\n${r.ipaddress ?? ''}`}>
                      {/* 헤더에서 얻은 값이라 앱을 고치지 않아도 채워진다.
                          "어느 것이 내 폰인가" 를 가리는 유일한 단서다. */}
                      {r.user_agent || '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {formatDateTime(r.requested_at)}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={g.canCall}
                        onCheckedChange={(v) => setGrant(r.id, { canCall: v })}
                        aria-label="통화 수신 허용"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={g.canControl}
                        onCheckedChange={(v) => setGrant(r.id, { canControl: v })}
                        aria-label="홈넷 제어 허용"
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button
                        size="sm"
                        disabled={busy === r.id}
                        onClick={() => act(r.id, () => api.approveEnrollment(r.id, g))}
                      >
                        {busy === r.id ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                        승인
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === r.id}
                        onClick={() => act(r.id, () => api.rejectEnrollment(r.id))}
                        aria-label="거절"
                      >
                        <X className="size-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* 둘 다 끈 채로 승인하면 등록만 되고 아무것도 못 한다. 의도일 수도
            있으므로 막지는 않되, 그렇게 되는 줄은 알려 준다. */}
        {records.some((r) => { const g = grantOf(r.id); return !g.canCall && !g.canControl; }) && (
          <p className="text-xs text-muted-foreground">
            <Badge variant="outline" className="mr-1.5 font-sans">참고</Badge>
            통화·제어를 모두 끈 채 승인하면 등록만 되고 전화도 제어도 되지 않습니다.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
