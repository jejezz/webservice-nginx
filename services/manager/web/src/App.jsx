import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/context/auth';
import { api } from '@/lib/api';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Setup from '@/pages/Setup';
import AdminConsole from '@/pages/AdminConsole';

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
          <RequireAuth>
            <Setup />
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
