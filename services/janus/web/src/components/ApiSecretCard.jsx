import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';

/**
 * 시그널링 API 비밀 — 클라이언트가 모든 요청에 실어야 하는 값.
 *
 * 서버에 들어가 파일을 열어 보는 것 말고는 볼 길이 없었습니다. 화면에서 꺼낼 수
 * 있게 하되, **세션 쿠키만으로는 주지 않습니다.** 로그인한 채 자리를 비운 화면
 * 하나로 새어 나가지 않도록, 볼 때마다 로그인 비밀번호를 다시 받습니다.
 *
 * 확인은 manager 가 합니다(계정을 소유한 쪽). 이 화면도, janus 대시보드 서버도
 * 비밀번호를 판단하거나 저장하지 않습니다.
 */

const HIDE_AFTER_MS = 60000;

export function ApiSecretCard() {
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);

  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  // 열어 둔 채 잊어버리는 것을 막는다. 1분 뒤 스스로 가린다.
  const hide = () => {
    clearTimeout(timer.current);
    setSecret(null);
    setAsking(false);
    setPassword('');
    setError('');
  };

  const reveal = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { apiSecret } = await api.apiSecret(password);
      setSecret(apiSecret);
      setPassword('');
      setAsking(false);
      timer.current = setTimeout(hide, HIDE_AFTER_MS);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? '비밀번호가 맞지 않습니다.'
          : err.message || '확인하지 못했습니다.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" />
          시그널링 API 비밀 (apisecret)
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          클라이언트가 <strong>모든 요청에</strong> 실어야 하는 값입니다. 빠지면 Janus 가{' '}
          <span className="font-mono">403 Unauthorized request</span> 로 돌려보내고, 세션조차 만들어지지
          않습니다.
        </p>

        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-muted/50 px-2 py-1.5 font-mono text-sm">
            {secret || '••••••••••••••••••••••••••••••••'}
          </code>

          {secret ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                title="복사"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {
                    /* 클립보드를 못 쓰면 직접 고르면 된다 */
                  }
                }}
              >
                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
              </Button>
              <Button variant="outline" size="sm" onClick={hide}>
                <EyeOff className="size-3.5" />
                가리기
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setAsking((v) => !v)}>
              <Eye className="size-3.5" />
              보기
            </Button>
          )}
        </div>

        {asking && !secret && (
          <form onSubmit={reveal} className="space-y-2 rounded-md border border-dashed p-3">
            <Label htmlFor="reveal-password" className="text-xs">
              로그인 비밀번호를 다시 넣으세요
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="reveal-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="비밀번호"
                className="h-8 flex-1"
                autoFocus
              />
              <Button type="submit" size="sm" disabled={busy || !password}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />}
                확인
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">
              지금 로그인한 계정의 비밀번호입니다. 확인은 manager 가 하고, 이 화면은 값을 갖고 있지 않습니다.
            </p>
          </form>
        )}

        {secret && (
          <Alert>
            <AlertDescription className="text-xs">
              1분 뒤 자동으로 가려집니다. 이 값은 <span className="font-mono">services/janus/secrets/api-secret</span> 에
              있고, <span className="font-mono">install.sh --apply</span> 가 만들었습니다.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
