import { useCallback, useState } from 'react';
import { AlertCircle, AlertTriangle, PhoneOff, Pencil, Plus, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import MobileForm from '@/components/MobileForm';

export default function Mobiles() {
  const { data, error, loading, refreshing, reload, setData } = usePolling(api.mobiles, 10000);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState('');
  // null 이면 닫힘, {} 면 추가, 행이면 수정.
  const [editing, setEditing] = useState(null);

  const toggle = useCallback(async (record) => {
    setBusy(record.id);
    setActionError('');
    try {
      const result = await api.toggleMobile(record.id);
      setData((prev) => ({
        ...prev,
        records: prev.records.map((r) => (r.id === result.id ? { ...r, active: result.active } : r)),
      }));
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(null);
    }
  }, [setData]);

  const remove = useCallback(async (record) => {
    if (!window.confirm(`단말 등록을 삭제합니다.\n\n${record.address} (${record.email})\n\n삭제하면 이 단말로 착신 알림이 가지 않습니다.`)) return;
    setBusy(record.id);
    setActionError('');
    try {
      await api.deleteMobile(record.id);
      setData((prev) => ({ ...prev, records: prev.records.filter((r) => r.id !== record.id) }));
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(null);
    }
  }, [setData]);

  if (loading) return <Skeleton className="h-72" />;

  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error || '데이터를 불러오지 못했습니다.'}</AlertDescription>
      </Alert>
    );
  }

  const q = filter.trim().toLowerCase();
  const records = q
    ? data.records.filter((r) =>
        [r.address, r.email, r.complex, r.complex_id, r.uuid, r.sip_user].some((v) => (v || '').toLowerCase().includes(q)))
    : data.records;

  // 조용히 망가져 있는 것들을 눈에 보이게 한다.
  const pushBroken = data.records.filter((r) => r.push_error).length;
  const noSipUser = data.records.filter((r) => !r.sip_user).length;
  // 이 서버가 맡은 단지. 다른 단지 값이 섞여 있으면 그 단말은 전화를 받지 못한다.
  const serverComplexId = data.complexId ?? null;
  const wrongComplex = serverComplexId
    ? data.records.filter((r) => r.complex_id && r.complex_id !== serverComplexId).length
    : 0;

  return (
    <>
      {(error || actionError) && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{actionError || error}</AlertDescription>
        </Alert>
      )}

      {wrongComplex > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            {wrongComplex}대가 다른 단지({serverComplexId} 아님)로 등록되어 있습니다.
            그 단말은 착신 대상 조회에 걸리지 않아 전화를 받지 못합니다.
          </AlertDescription>
        </Alert>
      )}
      {noSipUser > 0 && (
        <Alert>
          <PhoneOff />
          <AlertDescription>
            {noSipUser}대에 SIP 내선(sip_user)이 없습니다. 그 단말은 인터폰에서 건
            전화를 받지 못합니다 — 앱이 /register 에 sip_user 를 함께 보내야 합니다.
            (WebRTC 초인종 호출은 영향 없습니다)
          </AlertDescription>
        </Alert>
      )}
      {pushBroken > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            {pushBroken}대에 푸시가 닿지 않고 있습니다. FCM 이 모르는 토큰은 자동으로
            비활성이 되며, 단말이 다시 등록하면 되살아납니다.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">모바일 단말</h2>
          <p className="text-xs text-muted-foreground">
            등록 {data.records.length} · 착신 알림(FCM)은 활성 단말에만 갑니다
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="주소 · 이메일 · 단지 · uuid"
            className="h-9 w-56"
          />
          <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            새로고침
          </Button>
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus className="size-4" />
            단말 추가
          </Button>
        </div>
      </div>

      {records.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {data.records.length === 0 ? (
              <span className="inline-flex items-center gap-2">
                <Smartphone className="size-4" /> 등록된 단말이 없습니다.
              </span>
            ) : '검색 결과가 없습니다.'}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>주소</TableHead>
                  <TableHead>이메일</TableHead>
                  <TableHead>단지</TableHead>
                  <TableHead>단지 ID</TableHead>
                  <TableHead>SIP 내선</TableHead>
                  <TableHead>전화</TableHead>
                  <TableHead>토큰</TableHead>
                  <TableHead>등록</TableHead>
                  <TableHead className="text-center">활성</TableHead>
                  <TableHead className="text-right">수정 · 삭제</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs" title={r.uuid}>{r.address}</TableCell>
                    <TableCell className="text-xs">{r.email}</TableCell>
                    <TableCell className="text-xs">{r.complex}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {/*
                        표시용 이름(complex)과 달리 바뀌지 않는 식별자다. 비어 있으면
                        착신 대상 조회에 걸리지 않는다 — 단말이 다시 등록하면 채워진다.
                      */}
                      {r.complex_id
                        ? <span className={r.complex_id === serverComplexId || !serverComplexId
                            ? undefined : 'text-destructive'}>{r.complex_id}</span>
                        : <Badge variant="outline" className="font-sans">없음</Badge>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {/* 비어 있으면 이 단말은 인터폰 착신(SIP)을 받지 못한다. */}
                      {r.sip_user
                        ? r.sip_user
                        : <Badge variant="outline" className="font-sans">없음</Badge>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.phone || '—'}</TableCell>
                    <TableCell className="text-xs">
                      {/*
                        푸시가 실제로 닿는지. push_error 가 있으면 FCM 이 그 토큰을
                        거부한 것이고, 코드가 registration-token-not-registered 면
                        앱이 지워졌거나 다시 깔린 단말이다.
                      */}
                      {r.push_error ? (
                        <Badge
                          variant="destructive"
                          title={`${r.push_error}\n${formatDateTime(r.push_failed_at)}`}
                        >
                          {r.push_error.replace('messaging/', '')}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground" title={`토큰 갱신: ${formatDateTime(r.token_updated_at)}`}>
                          {formatDateTime(r.token_updated_at)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(r.created)}</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={r.active}
                        disabled={busy === r.id}
                        onCheckedChange={() => toggle(r)}
                        aria-label="활성 여부"
                      />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === r.id}
                        onClick={() => setEditing(r)}
                        aria-label="수정"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === r.id}
                        onClick={() => remove(r)}
                        aria-label="삭제"
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <MobileForm
        open={editing !== null}
        record={editing && editing.id ? editing : null}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        onSaved={reload}
      />
    </>
  );
}
