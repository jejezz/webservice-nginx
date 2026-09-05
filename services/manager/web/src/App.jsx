import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/context/auth';
import { api } from '@/lib/api';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Setup from '@/pages/Setup';
import AdminConsole from '@/pages/AdminConsole';
import PortMap from '@/pages/PortMap';
import Docs from '@/pages/Docs';

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * 이미 로그인한 상태로 /login에 온 경우.
 * 다른 서비스 대시보드에서 넘어왔다면(?next=) 그쪽으로 돌려보낸다.
 */
function AlreadyLoggedIn() {
  const next = new URLSearchParams(window.location.search).get('next');

  if (next && next.startsWith('/') && !next.startsWith('//')) {
    window.location.replace(next);
    return <FullPageSpinner />;
  }
  return <Navigate to="/dashboard" replace />;
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/**
 * 관리자 콘솔은 일반 로그인 세션과 별개의 쿠키를 쓴다.
 * 새로고침이나 직접 접근에도 서버에 물어 확인한다.
 */
/**
 * 구축 마법사는 **일반 세션 또는 관리자 콘솔 세션**으로 들어간다.
 *
 * 빈 장비에는 일반 세션을 낼 방법이 없다 — 그 세션은 로그인에서 나고, 로그인은
 * 계정을 MariaDB 에서 찾는데, MariaDB 를 세우는 것이 이 마법사의 2단계다.
 * 콘솔 세션은 그 고리 밖에 있다 (서버 쪽 requireAuthOrConsole).
 */
function RequireSetupAuth({ children }) {
  const { user, loading } = useAuth();
  const [console_, setConsole] = useState('checking');

  useEffect(() => {
    // 일반 세션이 있으면 콘솔에 물어볼 것이 없다.
    if (loading || user) return undefined;

    let cancelled = false;
    api.admin
      .me()
      .then(() => {
        if (!cancelled) setConsole('ok');
      })
      .catch(() => {
        if (!cancelled) setConsole('denied');
      });

    return () => {
      cancelled = true;
    };
  }, [loading, user]);

  if (loading) return <FullPageSpinner />;
  if (user) return children;
  if (console_ === 'checking') return <FullPageSpinner />;
  if (console_ === 'denied') return <Navigate to="/login" replace />;

  // 콘솔로 들어왔다는 것을 숨기지 않는다. 다른 자격이고 유효 시간도 짧다(30분).
  return (
    <>
      <div className="border-b bg-muted/40 px-4 py-2 text-center text-xs text-muted-foreground sm:px-6">
        관리자 콘솔 자격으로 들어와 있습니다. 확인 기록은{' '}
        <span className="font-mono">console:…</span> 로 남습니다.
      </div>
      {children}
    </>
  );
}

function RequireSuperAdmin({ children }) {
  const [state, setState] = useState('checking');

  useEffect(() => {
    let cancelled = false;

    api.admin
      .me()
      .then(() => {
        if (!cancelled) setState('ok');
      })
      .catch(() => {
        if (!cancelled) setState('denied');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'checking') return <FullPageSpinner />;
  if (state === 'denied') return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={loading ? <FullPageSpinner /> : user ? <AlreadyLoggedIn /> : <Login />} />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/setup"
        element={
          <RequireSetupAuth>
            <Setup />
          </RequireSetupAuth>
        }
      />
      <Route
        path="/port-map"
        element={
          <RequireAuth>
            <PortMap />
          </RequireAuth>
        }
      />
      <Route
        path="/docs"
        element={
          <RequireAuth>
            <Docs />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireSuperAdmin>
            <AdminConsole />
          </RequireSuperAdmin>
        }
      />
      <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
    </Routes>
  );
}
