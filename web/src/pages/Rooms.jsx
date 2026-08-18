import { AlertCircle, DoorOpen, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function RoomCard({ room }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <DoorOpen className="size-4" />
          <span className="font-mono">{room.roomId}</span>
        </CardTitle>
        <Badge variant="secondary">클라이언트 {room.clientCount}</Badge>
      </CardHeader>
      <CardContent>
        {room.clients.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            접속한 클라이언트가 없습니다. (등록 대기 중이면 {room.registerTimeout}ms 후 정리됩니다)
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>클라이언트</TableHead>
                  <TableHead>주소</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>장치</TableHead>
                  <TableHead className="text-right">대기 메시지</TableHead>
                  <TableHead className="text-right">상태</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {room.clients.map((c) => (
                  <TableRow key={c.clientId}>
                    <TableCell className="font-mono text-xs">
                      {c.clientId}
                      {c.initiator && <Badge variant="outline" className="ml-2">발신</Badge>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.address || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{c.ipAddress || '—'}</TableCell>
                    <TableCell className="text-xs">{c.device || '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{c.queued}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={c.alive ? 'success' : 'destructive'}>
                        {c.alive ? '연결' : '끊김'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Rooms() {
  const { data, error, loading, refreshing, reload } = usePolling(api.rooms, 3000);

  if (loading) return <div className="space-y-4">{[0, 1].map((i) => <Skeleton key={i} className="h-40" />)}</div>;

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
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">방</h2>
          <p className="text-xs text-muted-foreground">
            방 {data.totalRooms} · 연결 {data.totalConnections} · 3초마다 갱신
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
          새로고침
        </Button>
      </div>

      {data.rooms.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            활성 방이 없습니다.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {data.rooms.map((room) => <RoomCard key={room.roomId} room={room} />)}
        </div>
      )}
    </>
  );
}
