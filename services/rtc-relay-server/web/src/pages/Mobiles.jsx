import { useCallback, useState } from 'react';
import { AlertCircle, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
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

export default function Mobiles() {
  const { data, error, loading, refreshing, reload, setData } = usePolling(api.mobiles, 10000);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState('');

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
        [r.address, r.email, r.complex, r.uuid].some((v) => (v || '').toLowerCase().includes(q)))
    : data.records;

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
                  <TableHead>전화</TableHead>
                  <TableHead>등록</TableHead>
                  <TableHead className="text-center">활성</TableHead>
                  <TableHead className="text-right">삭제</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs" title={r.uuid}>{r.address}</TableCell>
                    <TableCell className="text-xs">{r.email}</TableCell>
                    <TableCell className="text-xs">{r.complex}</TableCell>
                    <TableCell className="font-mono text-xs">{r.phone || '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(r.created)}</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={r.active}
                        disabled={busy === r.id}
                        onCheckedChange={() => toggle(r)}
                        aria-label="활성 여부"
                      />
                    </TableCell>
                    <TableCell className="text-right">
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
    </>
  );
}
