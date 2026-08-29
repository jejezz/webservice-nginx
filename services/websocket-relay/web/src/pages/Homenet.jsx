import { useCallback, useState } from 'react';
import { AlertCircle, House, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import HomenetForm from '@/components/HomenetForm';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function Homenet() {
  const { data, error, loading, refreshing, reload, setData } = usePolling(api.homenet, 15000);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState('');
  const [adding, setAdding] = useState(false);

  const remove = useCallback(async (record) => {
    if (!window.confirm(`홈넷 장치 등록을 삭제합니다.\n\n${record.building}동 ${record.unit}호`)) return;
    setBusy(record.id);
    setActionError('');
    try {
      await api.deleteHomenet(record.id);
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

  return (
    <>
      {(error || actionError) && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{actionError || error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">홈넷 장치</h2>
          <p className="text-xs text-muted-foreground">
            등록 {data.records.length} · 단지·동·호 조합이 장치의 신원입니다
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            새로고침
          </Button>
          <Button size="sm" onClick={() => { setActionError(''); setAdding(true); }}>
            <Plus className="size-4" />
            장치 추가
          </Button>
        </div>
      </div>

      {data.records.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-10 text-center text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <House className="size-4" /> 등록된 홈넷 장치가 없습니다.
            </span>
            {/* 여기가 비어 있으면 그 단지의 모바일 등록은 전부 409 no_wallpad 다. */}
            <p className="text-xs">
              세대가 하나도 없으면 앱의 등록 요청이 모두 거부됩니다 (<code>no_wallpad</code>).
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>단지 ID</TableHead>
                  <TableHead>동</TableHead>
                  <TableHead>호</TableHead>
                  <TableHead>종류</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>등록</TableHead>
                  <TableHead className="text-right">삭제</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.records.map((r) => (
                  <TableRow key={r.id}>
                    {/*
                      표시 이름 대신 단지코드를 보여준다. 이름은 월패드가 보내던
                      자유 문자열이었고 오타가 세대를 복제했다 (schema/008).
                    */}
                    <TableCell className="font-mono text-xs">
                      {r.complex_id || <span className="text-muted-foreground">미설정</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.building}</TableCell>
                    <TableCell className="font-mono text-xs">{r.unit}</TableCell>
                    <TableCell className="text-xs">{r.type}</TableCell>
                    <TableCell className="font-mono text-xs">{r.ipaddress}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(r.created)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => remove(r)} aria-label="삭제">
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

      <HomenetForm
        open={adding}
        onOpenChange={setAdding}
        onSaved={reload}
      />
    </>
  );
}
