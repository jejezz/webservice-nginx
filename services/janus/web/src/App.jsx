import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ArrowLeft, Activity, PhoneCall } from 'lucide-react';
import Overview from '@/pages/Overview';
import TestCall from '@/pages/TestCall';
import { cn } from '@/lib/utils';

// 세션 · SIP · 미디어 화면은 계획서 8단계에서 Admin API 로 채운다.
const TABS = [
  { to: '/', label: '개요', Icon: Activity, end: true },
  { to: '/test-call', label: '시험 통화', Icon: PhoneCall },
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
            <h1 className="text-sm font-semibold leading-tight">Janus</h1>
            <p className="text-xs text-muted-foreground">WebRTC ↔ SIP 게이트웨이</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <a
            href="/kamailio/dashboard"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Kamailio
          </a>
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
          <Route path="/test-call" element={<TestCall />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
