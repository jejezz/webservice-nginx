import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Activity, ArrowLeft, BarChart3, Globe, Radio, ScrollText, UserRound } from 'lucide-react';
import Overview from '@/pages/Overview';
import Registrations from '@/pages/Registrations';
import WebSockets from '@/pages/WebSockets';
import Accounts from '@/pages/Accounts';
import Stats from '@/pages/Stats';
import Logs from '@/pages/Logs';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/', label: '개요', Icon: Activity, end: true },
  { to: '/registrations', label: '등록 단말', Icon: Radio },
  { to: '/websockets', label: 'WebSocket', Icon: Globe },
  { to: '/accounts', label: 'SIP 계정', Icon: UserRound },
  { to: '/stats', label: '통계', Icon: BarChart3 },
  { to: '/logs', label: '로그', Icon: ScrollText },
];

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 pt-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg border bg-card">
            <Activity className="size-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-tight">Kamailio</h1>
            <p className="text-xs text-muted-foreground">SIP 서버 상태 관찰</p>
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
          <Route path="/registrations" element={<Registrations />} />
          <Route path="/websockets" element={<WebSockets />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
