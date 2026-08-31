import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Clock, Loader2, Lock, Server, Settings } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/context/auth';
import AdminLoginDialog from '@/components/AdminLoginDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 다른 서비스 대시보드에서 넘어온 경우 ?next=로 원래 목적지가 전달된다.
 * 오픈 리다이렉트를 막기 위해 같은 오리진의 절대 경로만 허용한다.
 */
function safeNext(raw) {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next'));

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);

  // 어느 장비에 로그인하는 중인지. 서버가 여러 대일 때 헷갈리지 않도록 띄운다.
  // 못 가져와도 로그인은 되어야 하므로 실패는 조용히 넘긴다.
  const [host, setHost] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.host()
      .then((data) => { if (!cancelled) setHost(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const insecure = typeof window !== 'undefined' && window.location.protocol !== 'https:';

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);

    try {
      await login(username.trim(), password);

      if (next) {
        // 다른 서비스의 대시보드는 이 SPA 바깥이므로 전체 이동한다.
        window.location.replace(next);
        return;
      }
      navigate('/dashboard', { replace: true });
    } catch (err) {
      // 승인 대기는 실패가 아니라 안내다.
      if (err.code === 'pending_approval') {
        setNotice(err.message);
      } else {
        setError(err.message || '로그인에 실패했습니다.');
      }
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-4">
      {/* 관리자 콘솔 진입점. 눈에 띄지 않게 구석에 둔다. */}
      <button
        type="button"
        onClick={() => setAdminOpen(true)}
        title="관리자 설정"
        aria-label="관리자 설정"
        className="absolute right-4 top-4 rounded-md p-2 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Settings className="size-4" />
      </button>

      <AdminLoginDialog
        open={adminOpen}
        onOpenChange={setAdminOpen}
        onSuccess={() => {
          setAdminOpen(false);
          navigate('/admin', { replace: false });
        }}
      />

      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center space-y-2 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl border bg-card">
            <Server className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Nginx Manager</h1>
          <p className="text-sm text-muted-foreground">서비스 상태를 확인하려면 로그인하세요.</p>

          {/* 장비 식별. 값을 못 받으면 자리를 차지하지 않는다. */}
          {host?.hostname && (
            <p className="pt-1 font-mono text-xs text-muted-foreground">
              {host.hostname}
              {host.address && (
                <>
                  <span className="px-1.5 text-muted-foreground/50">·</span>
                  {host.address}
                </>
              )}
            </p>
          )}
        </div>

        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="size-4" />
              로그인
            </CardTitle>
            <CardDescription>등록되지 않은 이메일은 승인 요청으로 접수됩니다.</CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">이메일</Label>
                <Input
                  id="username"
                  name="username"
                  type="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  autoComplete="username"
                  autoFocus
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={submitting}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">비밀번호</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {notice && (
                <Alert>
                  <Clock />
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                로그인
              </Button>
            </form>
          </CardContent>
        </Card>

        {insecure && (
          <Alert variant="warning">
            <AlertCircle />
            <AlertDescription>
              암호화되지 않은 HTTP 연결입니다. 자격 증명이 평문으로 전송되므로 HTTPS로 접속하세요.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
