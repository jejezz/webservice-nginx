import { Card, CardContent } from '@/components/ui/card';
import LogsView from '@/components/LogsView';

/**
 * coturn 로그.
 *
 * 기본 로그 수준에서는 기동·설정 요약·오류만 남습니다. 할당·인증 실패를
 * 자세히 보려면 turnserver.conf 에 verbose 를 추가해야 하는데, 그러면
 * 클라이언트 IP·포트가 더 자세히 남는 대신 로그량도 크게 늘어납니다 —
 * v1 에서는 기본 수준으로 둡니다.
 */
export default function Logs() {
  return (
    <LogsView
      unit="coturn"
      hint={
        <Card>
          <CardContent className="space-y-2 p-4 text-xs text-muted-foreground">
            <p>
              <strong className="text-foreground">자주 찾을 문구</strong>
            </p>
            <pre className="overflow-x-auto rounded border bg-muted/40 p-2 font-mono">
              {`allocate      새 릴레이 할당
unauthorized  자격 증명 검증 실패 — realm·static-auth-secret 확인
Cannot bind   listening-port/relay 범위가 다른 프로세스와 겹침`}
            </pre>
            <p>
              세션·할당 개수는 이 화면에 없습니다 — coturn 의 관리 CLI(no-cli 로 꺼둠)가 있어야
              알 수 있는 값입니다. 개요 탭의 "이 화면이 보여 주지 않는 것" 을 참고하세요.
            </p>
          </CardContent>
        </Card>
      }
    />
  );
}
