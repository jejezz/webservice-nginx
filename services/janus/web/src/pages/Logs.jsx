import { Card, CardContent } from '@/components/ui/card';
import LogsView from '@/components/LogsView';

/**
 * Janus 로그.
 *
 * 기본 로그 수준(debug_level = 4)에서는 연결과 오류만 남습니다. 클라이언트가
 * 무엇을 보냈는지까지 보려면 수준을 올려야 하는데, 그러면 register 본문에 실린
 * **SIP 계정 비밀번호까지 저널에 남습니다.** 그 경고를 화면에 함께 둡니다.
 */
export default function Logs() {
  return (
    <LogsView
      unit="janus"
      hint={
        <Card>
          <CardContent className="space-y-2 p-4 text-xs text-muted-foreground">
            <p>
              <strong className="text-foreground">로그가 조용하다면 그게 정상입니다.</strong>{' '}
              <span className="font-mono">janus.jcfg</span> 의{' '}
              <span className="font-mono">debug_level = 4</span> 에서는 연결·해제와 오류만 남습니다. 클라이언트가
              보낸 JSON 까지 보려면 수준을 올려야 합니다.
            </p>
            <pre className="overflow-x-auto rounded border bg-muted/40 p-2 font-mono">
              {`# 재기동 없이 올린다 (Admin API, 루프백 전용)
SECRET=$(head -1 services/janus/secrets/admin-secret)
curl -s -H 'Content-Type: application/json' \\
  -d "{\\"janus\\":\\"set_log_level\\",\\"level\\":6,\\"transaction\\":\\"t\\",\\"admin_secret\\":\\"$SECRET\\"}" \\
  http://127.0.0.1:7088/admin

# 보고 나면 반드시 되돌린다
#   위 명령에서 "level":4`}
            </pre>
            <p className="text-warning">
              ⚠️ 수준 6 이상에서는 <span className="font-mono">register</span> 본문이 통째로 찍혀{' '}
              <strong>SIP 계정 비밀번호가 저널에 남습니다.</strong> 필요한 만큼만 올렸다 바로 되돌리세요.
            </p>
            <p>
              세션·핸들·SDP·ICE 상태는 로그보다 <strong className="text-foreground">세션·미디어</strong> 탭이
              읽기 쉽습니다. 로그는 "무엇이 실패했나" 를 볼 때 씁니다.
            </p>
          </CardContent>
        </Card>
      }
    />
  );
}
