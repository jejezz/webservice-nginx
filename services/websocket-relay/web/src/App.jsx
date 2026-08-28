import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ArrowLeft, DoorOpen, House, Plug, Radio, Smartphone } from 'lucide-react';
import Overview from '@/pages/Overview';
import Rooms from '@/pages/Rooms';
import Mobiles from '@/pages/Mobiles';
import Homenet from '@/pages/Homenet';
import Tester from '@/pages/Tester';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/', label: '개요', Icon: Radio, end: true },
  { to: '/rooms', label: '방', Icon: DoorOpen },
  { to: '/mobiles', label: '모바일 단말', Icon: Smartphone },
  { to: '/homenet', label: '홈넷 장치', Icon: House },
  { to: '/tester', label: '연결 테스트', Icon: Plug },
];

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

        <a
          href="/manager/dashboard"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Nginx Manager
        </a>
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
