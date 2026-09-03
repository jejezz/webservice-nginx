import { AlertCircle, AlertTriangle, DoorOpen, House, PhoneCall, RefreshCw, Settings } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * 방의 종류.
 *
 * 같은 방 구조가 전혀 다른 두 용도로 쓰인다. 어느 쪽인지 모르면 표의 값들이
 * 무슨 뜻인지 알 수 없다 — 특히 '발신' 자리에 앉은 클라이언트가 통화를 건
 * 쪽인지 홈넷 컨트롤러인지가 완전히 다르다.
 */
const KIND = {
  rtc: {
    label: '통화',
    Icon: PhoneCall,
    variant: 'default',
    initiator: '발신',
    hint: '홈넷 장치 ↔ 모바일 한 대. 먼저 응답한 단말만 들어온다',
  },
  iot: {
    label: '홈넷',
    Icon: House,
    variant: 'secondary',
    initiator: '홈넷',
    hint: '홈넷 장치 1대 ↔ 모바일 여러 대. 제어는 홈넷으로, 상태는 구독 단말에 뿌린다',
  },
  admin: {
    label: '관리',
    Icon: Settings,
    variant: 'outline',
    initiator: '—',
    hint: '기동할 때 만드는 관리용 방. 클라이언트가 붙지 않는다',
  },
  unknown: {
    label: '미상',
    Icon: DoorOpen,
    variant: 'outline',
    initiator: '최초',
    hint: '용도가 정해지기 전의 방',
  },
};

function RoomCard({ room }) {
  const kind = KIND[room.kind] ?? KIND.unknown;
  const { Icon } = kind;
  const isIot = room.kind === 'iot';

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4" />
            <span className="font-mono">{room.roomId}</span>
            <Badge variant={kind.variant}>{kind.label}</Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            {isIot && room.subscriberCount > 0 && (
              <Badge variant="outline">구독 {room.subscriberCount}</Badge>
            )}
            <Badge variant="secondary">
              클라이언트 {room.clientCount}/{room.capacity}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{kind.hint}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {room.warnings?.map((w) => (
          <Alert key={w} variant="destructive">
            <AlertTriangle />
            <AlertDescription>{w}</AlertDescription>
          </Alert>
        ))}

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
                  {isIot && <TableHead className="text-right">구독</TableHead>}
                  <TableHead className="text-right">대기 메시지</TableHead>
                  <TableHead className="text-right">상태</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {room.clients.map((c) => (
                  <TableRow key={c.clientId}>
                    <TableCell className="font-mono text-xs">
                      {c.clientId}
                      {c.initiator && (
                        <Badge variant="outline" className="ml-2">{kind.initiator}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.address || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{c.ipAddress || '—'}</TableCell>
                    <TableCell className="text-xs">{c.device || c.agent || '—'}</TableCell>
                    {isIot && (
                      <TableCell className="text-right">
                        {/* 홈넷 장치는 구독 대상이 아니라 뿌리는 쪽이다. */}
                        {c.initiator ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <Badge variant={c.subscription ? 'success' : 'outline'}>
                            {c.subscription ? '구독' : '미구독'}
                          </Badge>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-right font-mono text-xs tabular-nums">{c.queued}</TableCell>
                    <TableCell className="text-right">
                      {/*
                        connected 는 소켓이 실제로 열려 있는지, alive 는 지난 ping 에
                        pong 이 왔는지다. 자리는 남아 있는데 소켓이 없는 상태(로밍
                        재접속 유예)를 '끊김'과 구별해서 보여준다.
                      */}
                      {!c.connected ? (
                        <Badge variant="destructive">소켓 없음</Badge>
                      ) : (
                        <Badge variant={c.alive ? 'success' : 'warning'}>
                          {c.alive ? '연결' : '응답 없음'}
                        </Badge>
                      )}
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

  const kinds = data.byKind ?? {};
  // 용도별로 나눠서 센다. 합계만으로는 통화 중인지 홈넷 세션인지 알 수 없다.
  const breakdown = [
    kinds.rtc ? `통화 ${kinds.rtc}` : null,
    kinds.iot ? `홈넷 ${kinds.iot}` : null,
    kinds.admin ? `관리 ${kinds.admin}` : null,
    kinds.unknown ? `미상 ${kinds.unknown}` : null,
  ].filter(Boolean).join(' · ');

  const warned = data.rooms.filter((r) => r.warnings?.length > 0).length;

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
            방 {data.totalRooms}
            {breakdown && ` (${breakdown})`} · 연결 {data.totalConnections} · 3초마다 갱신
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
          새로고침
        </Button>
      </div>

      {warned > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{warned}개 방에 확인할 것이 있습니다.</AlertDescription>
        </Alert>
      )}

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
