import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Terminal } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

/**
 * 배포 설정 — 장비마다 다르고 회선 따라 바뀌는 값들.
 *
 * ⚠️ 이 화면은 **settings.ini 에 값을 적을 뿐입니다.** 실제 반영은 사람이
 *    터미널에서 `sudo ./install.sh --apply` 를 실행해야 일어납니다. 대시보드가
 *    sudo 를 부르는 길은 두지 않습니다 — Janus 를 재기동하는 일을 웹 화면의
 *    단추 하나에 걸어 두지 않으려는 것입니다.
 *
 * 화면은 서버가 준 스키마로 그립니다. 설정을 하나 늘릴 때 이 파일은 손대지
 * 않아도 됩니다 (server/src/settings.js 의 SCHEMA 참고).
 */

function CommandBox({ command, cwd }) {
  const [copied, setCopied] = useState(false);
  const full = `cd ${cwd}\n${command}`;

  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded bg-muted/60 p-3 font-mono text-xs leading-relaxed">
        {full}
      </pre>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          // 클립보드는 https 나 localhost 에서만 됩니다. 안 되면 조용히 넘어가고
          // 사용자는 위 상자에서 직접 고르면 됩니다.
          navigator.clipboard?.writeText(full).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
            () => {}
          );
        }}
      >
        {copied ? '복사됨' : '명령 복사'}
      </Button>
    </div>
  );
}

export default function Settings() {
  const [state, setState] = useState(null);
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const load = () =>
    api.settings()
      .then((s) => { setState(s); setForm(s.values); setLoadError(''); })
      .catch((e) => setLoadError(e.message));

  useEffect(() => { load(); }, []);

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>설정을 불러오지 못했습니다</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }
  if (!state) return <Skeleton className="h-64" />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErrors({}); setJustSaved(false);
    try {
      const next = await api.saveSettings(form);
      setState(next); setForm(next.values); setJustSaved(true);
    } catch (err) {
      setErrors(err.payload?.errors || { _: err.message });
    } finally {
      setBusy(false);
    }
  };

  const dirty = state.schema.some((s) => (form[s.key] ?? '') !== (state.values[s.key] ?? ''));
  const pending = state.pending.length > 0;
  const cwd = state.settingsPath.replace(/\/settings\.ini$/, '');
  const range = state.values.rtp_port_range;

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-4">
        {state.schema.map((s) => (
          <Card key={s.key}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">{s.label}</CardTitle>
                {s.optional && <Badge variant="secondary">선택</Badge>}
                {state.pending.includes(s.key) && <Badge variant="outline">적용 대기</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">{s.help}</p>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor={s.key} className="sr-only">{s.label}</Label>
              <Input
                id={s.key}
                value={form[s.key] ?? ''}
                placeholder={s.placeholder}
                className="font-mono"
                onChange={(e) => setForm({ ...form, [s.key]: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{s.effect}</p>
              {errors[s.key] && (
                <p className="text-xs font-medium text-destructive">{errors[s.key]}</p>
              )}
              {state.everApplied && (
                <p className="text-xs text-muted-foreground">
                  마지막으로 적용된 값:{' '}
                  <span className="font-mono">{state.applied[s.key] || '(비어 있음)'}</span>
                </p>
              )}
            </CardContent>
          </Card>
        ))}

        {errors._ && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{errors._}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !dirty}>
            {busy ? '저장 중…' : '저장'}
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">저장하지 않은 변경이 있습니다.</span>}
          {justSaved && !dirty && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 className="size-3.5" /> settings.ini 에 저장했습니다
            </span>
          )}
        </div>
      </form>

      {/*
        저장은 파일에만 남습니다. 여기서부터가 사람이 해야 하는 부분이고,
        그것을 숨기지 않고 그대로 보여 주는 것이 이 화면의 요점입니다.
      */}
      <Card className={pending ? 'border-warning' : undefined}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Terminal className="size-4" />
            <CardTitle className="text-sm">
              {pending ? '아직 반영되지 않았습니다 — 아래를 실행하세요' : '반영하려면'}
            </CardTitle>
          </div>
          <p className="text-xs text-muted-foreground">
            이 화면은 파일에 값을 적을 뿐입니다. Janus 에 반영하는 것은
            <strong> 사람이 터미널에서</strong> 합니다 — 재기동이 걸리는 일이라
            웹 단추에 걸어 두지 않았습니다.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <CommandBox command={state.applyCommand} cwd={cwd} />

          <div className="space-y-1 text-xs text-muted-foreground">
            <p>실패하면 아무것도 바꾸지 않고 이전 설정으로 되돌립니다.</p>
            {!state.everApplied && (
              <p>아직 한 번도 적용한 적이 없습니다 (<code>.applied-settings</code> 없음).</p>
            )}
          </div>

          {state.values.public_ip ? (
            <Alert>
              <AlertCircle className="size-4" />
              <AlertTitle>공유기에서 포워딩도 열어야 합니다</AlertTitle>
              <AlertDescription className="space-y-1 text-xs">
                <p>
                  <span className="font-mono">UDP {range}</span> →{' '}
                  <span className="font-mono">192.168.0.252</span>
                </p>
                <p>
                  시그널링(<span className="font-mono">28443 → 443</span>)은 이미 있으므로 추가로 열 것이 없습니다.
                  미디어만 열면 됩니다.
                </p>
                <p>
                  공인 IP 는 회선 따라 바뀝니다. 바뀌면 신호는 붙는데 소리가 나지 않으므로,
                  <span className="font-mono"> ./check-public-ip.sh</span> 를 크론에 걸어 두는 것을 권합니다.
                </p>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <AlertCircle className="size-4" />
              <AlertDescription className="text-xs">
                공인 IP 가 비어 있어 <strong>LAN 전용</strong>으로 설치됩니다. 외부(인터넷)
                브라우저를 받으려면 공인 IP 를 넣으세요.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        값은 <code>{state.settingsPath}</code> 에 저장됩니다. 커밋되지 않습니다 —
        장비마다 다른 값입니다. 손으로 고쳐도 되고, 어느 쪽이든 같은 검증을 거칩니다.
      </p>
    </div>
  );
}
