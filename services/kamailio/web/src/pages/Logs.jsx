import { Card, CardContent } from '@/components/ui/card';
import LogsView from '@/components/LogsView';

/**
 * Kamailio 로그.
 *
 * 이 서비스도 systemd 가 띄웁니다. 무엇을 보고 싶은지에 따라 필터가 정해져
 * 있어서, 자주 쓰는 것을 화면에 적어 둡니다.
 */
export default function Logs() {
  return (
    <LogsView
      unit="kamailio"
      hint={
        <Card>
          <CardContent className="space-y-2 p-4 text-xs text-muted-foreground">
            <p>
              <strong className="text-foreground">자주 쓰는 필터</strong> — 위 필터 칸에 그대로 넣으세요.
            </p>
            <ul className="space-y-1 font-mono">
              <li>REGISTER — 등록 요청과 401 인증 흐름</li>
              <li>INVITE — 통화 시도</li>
              <li>ts_store|ts_append — 착신 푸시로 붙들어 둔 INVITE</li>
              <li>sip-push — rtc-relay-server 로 나간 깨우기 요청</li>
            </ul>
            <p>
              등록된 단말과 온라인 상태는 로그보다 <strong className="text-foreground">등록</strong> 탭이 정확합니다 —
              그쪽은 Kamailio 에 직접 물어봅니다.
            </p>
          </CardContent>
        </Card>
      }
    />
  );
}
