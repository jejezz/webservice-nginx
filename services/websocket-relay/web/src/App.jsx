import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, BellRing, DoorOpen, House, Plug, Radio, Smartphone } from 'lucide-react';
import Overview from '@/pages/Overview';
import Rooms from '@/pages/Rooms';
import Mobiles from '@/pages/Mobiles';
import Homenet from '@/pages/Homenet';
import Tester from '@/pages/Tester';
import PushKey from '@/pages/PushKey';
import { useSession, formatRemaining } from '@/lib/useSession';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/', label: '개요', Icon: Radio, end: true },
  { to: '/rooms', label: '방', Icon: DoorOpen },
  { to: '/mobiles', label: '모바일 단말', Icon: Smartphone },
  { to: '/homenet', label: '홈넷 장치', Icon: House },
  { to: '/push-key', label: '푸시 키', Icon: BellRing },
  { to: '/tester', label: '연결 테스트', Icon: Plug },
];

/**
 * 로그인한 사람과 세션이 얼마나 남았는지.
 *
 * 서버는 요청마다 만료를 확인하고 401 을 주지만, 그것만으로는 **사람에게
 * 예고가 없다.** 무언가 고치다가 저장을 누르는 순간 로그인으로 튕기고 입력이
 * 사라진다. 세션 기본값이 2시간이라 오후 내내 열어 두면 실제로 겪는 일이다.
 */
function SessionBadge() {
  const { user, remainingMs, expiring } = useSession();
  if (!user) return null;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{user.displayName || user.username}</span>
      {remainingMs !== null && (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 tabular-nums',
            expiring
              ? 'border-destructive/50 text-destructive'
              : 'text-muted-foreground'
          )}
          title={expiring
            ? '곧 만료됩니다. 지금 하던 작업을 저장하고 manager 에서 다시 로그인하세요.'
            : 'manager 로그인 세션이 남은 시간입니다.'}
        >
          {expiring && <AlertTriangle className="size-3" />}
          {formatRemaining(remainingMs)}
        </span>
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 pt-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg border bg-card">
            <Radio className="size-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-tight">WebSocket Relay</h1>
            <p className="text-xs text-muted-foreground">WebRTC 시그널링 · IoT · SIP 착신 릴레이 관리</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <SessionBadge />
          <a
            href="/manager/dashboard"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Nginx Manager
          </a>
        </div>
      </div>

      <nav className="mx-auto flex max-w-6xl gap-1 px-4 sm:px-6">
        {TABS.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors',
                isActive
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/rooms" element={<Rooms />} />
          <Route path="/mobiles" element={<Mobiles />} />
          <Route path="/homenet" element={<Homenet />} />
          <Route path="/tester" element={<Tester />} />
          <Route path="/push-key" element={<PushKey />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
