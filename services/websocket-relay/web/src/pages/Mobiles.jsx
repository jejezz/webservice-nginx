import { useCallback, useState } from 'react';
import { AlertCircle, AlertTriangle, BellRing, PhoneOff, Pencil, Plus, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
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
import PendingEnrollments from '@/components/PendingEnrollments';
import TestPushDialog from '@/components/TestPushDialog';
import { toKorean } from '@/lib/address';

export default function Mobiles() {
  const { data, error, loading, refreshing, reload, setData } = usePolling(api.mobiles, 10000);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState('');
  // null 이면 닫힘, {} 면 추가, 행이면 수정.
  const [editing, setEditing] = useState(null);
  // 시험 푸시를 보낼 단말. null 이면 닫힘.
  const [testing, setTesting] = useState(null);
  // 동/호 필터. 빈 값이면 전체.
  const [home, setHome] = useState('');

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

  /**
   * 통화/제어 권한을 바꾼다.
   *
   * active 토글과 **다른 API** 를 쓴다. active 는 FCM 이 자동으로 내리고
   * 올리는 푸시 건강 상태이고, 이쪽은 사람이 정하는 권한이다
   * (schema/005-enrollment.sql).
   */
  const setPermission = useCallback(async (record, patch) => {
    setBusy(record.id);
    setActionError('');
    try {
      const result = await api.setMobilePermissions(record.id, patch);
      setData((prev) => ({
        ...prev,
        records: prev.records.map((r) => (r.id === result.id
          ? { ...r, can_call: result.can_call, can_control: result.can_control }
          : r)),
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
  const byHome = home ? data.records.filter((r) => r.address === home) : data.records;
  const records = q
    ? byHome.filter((r) =>
        [r.address, r.email, r.complex, r.complex_id, r.uuid, r.sip_user].some((v) => (v || '').toLowerCase().includes(q)))
    : byHome;

  // 동/호 목록은 등록된 단말에서 뽑는다. 별도 조회를 하지 않아도 되고,
  // 고를 수 있는 값이 곧 결과가 있는 값이라 빈 화면이 나오지 않는다.
  const homes = Array.from(new Set(data.records.map((r) => r.address).filter(Boolean))).sort();

  // 승인은 됐지만 통화가 막힌 단말. 조용히 전화를 못 받는 상태라 드러낸다.
  const noCall = data.records.filter((r) => !r.can_call).length;

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

      {noCall > 0 && (
        <Alert>
          <PhoneOff />
          <AlertDescription>
            {noCall}대가 <strong>통화 수신이 꺼져</strong> 있습니다. 등록은 되어 있지만
            초인종·전화가 그 단말로 가지 않습니다. 승인할 때 통화를 켜지 않았거나,
            나중에 꺼진 것입니다.
          </AlertDescription>
        </Alert>
      )}

      <PendingEnrollments address={home || undefined} onApproved={reload} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">모바일 단말</h2>
          <p className="text-xs text-muted-foreground">
            등록 {data.records.length} · 착신 알림(FCM)은 활성 단말에만 갑니다
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={home}
            onChange={(e) => setHome(e.target.value)}
            aria-label="동/호 필터"
            className="h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="">전체 세대</option>
            {homes.map((a) => <option key={a} value={a}>{toKorean(a)}</option>)}
          </select>
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
                  <TableHead className="text-center">통화</TableHead>
                  <TableHead className="text-center">제어</TableHead>
                  <TableHead className="text-center">활성</TableHead>
                  <TableHead className="text-right">시험 · 수정 · 삭제</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs" title={`${r.address}\n${r.uuid}`}>{toKorean(r.address)}</TableCell>
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
                    {/* 사람이 정하는 권한. 통화가 꺼지면 초인종이 이 단말을 부르지 않는다. */}
                    <TableCell className="text-center">
                      <Switch
                        checked={r.can_call}
                        disabled={busy === r.id}
                        onCheckedChange={(v) => setPermission(r, { canCall: v })}
                        aria-label="통화 수신 허용"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={r.can_control}
                        disabled={busy === r.id}
                        onCheckedChange={(v) => setPermission(r, { canControl: v })}
                        aria-label="홈넷 제어 허용"
                      />
                    </TableCell>
                    {/* 기계가 정하는 푸시 건강 상태. 위의 권한과 다른 축이다. */}
                    <TableCell className="text-center">
                      <Switch
                        checked={r.active}
                        disabled={busy === r.id}
                        onCheckedChange={() => toggle(r)}
                        aria-label="활성 여부"
                      />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {/*
                        토큰이 없으면 눌러 봐야 400 밖에 오지 않는다. 목록은 토큰
                        자체를 내려받지 않으므로 서버가 준 has_token 으로 가른다.
                      */}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === r.id || !r.has_token}
                        onClick={() => setTesting(r)}
                        aria-label="시험 푸시"
                        title={r.has_token ? '이 단말에 시험 푸시를 보냅니다' : 'FCM 토큰이 없는 단말입니다'}
                      >
                        <BellRing className="size-4" />
                      </Button>
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

      <TestPushDialog
        open={testing !== null}
        record={testing}
        onOpenChange={(open) => { if (!open) setTesting(null); }}
        onChanged={reload}
      />
    </>
  );
}
