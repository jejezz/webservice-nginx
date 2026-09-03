import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 홈넷 장치(월패드) 를 손으로 넣는 폼.
 *
 * 정상 경로는 월패드가 스스로 `POST /register/complex_agents` 를 부르는 것이다.
 * 이 화면은 **그 전에** 세대를 열어 둬야 할 때 쓴다 — 그 동/호가 이 표에 없으면
 * 모바일 등록이 `409 no_wallpad` 로 끝나서, 월패드가 없는 집에서는 앱의 등록
 * 흐름을 한 걸음도 볼 수 없기 때문이다.
 *
 * 수정은 없다. 동·호가 곧 이 행의 신원이고 나머지(종류·IP)는 장치가 붙으면서
 * 제 값으로 덮어쓰므로, 고칠 것이 있으면 지우고 다시 넣는 편이 낫다.
 *
 * **단지는 묻지 않는다.** 한 서버가 한 단지를 맡으므로 이 서버에 넣는 행은
 * 정의상 이 단지다 — 서버가 자기 단지 ID 를 채운다 (schema/008).
 */

const EMPTY = { type: 'wallpad', building: '', unit: '', ipaddress: '' };

export default function HomenetForm({ open, onOpenChange, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setForm(EMPTY);
  }, [open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');

    const body = {
      type: form.type.trim() || 'wallpad',
      building: form.building.trim(),
      unit: form.unit.trim(),
      // 비워 두면 서버가 0.0.0.0 으로 둔다. 장치가 처음 붙을 때 제 값으로 바뀐다.
      ipaddress: form.ipaddress.trim(),
    };

    const missing = ['building', 'unit'].filter((k) => !body[k]);
    if (missing.length > 0) {
      setError('동, 호를 채우세요.');
      return;
    }

    setSaving(true);
    try {
      await api.createHomenet(body);
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-lg" labelledBy="homenet-form-title">
      <DialogClose onClick={() => onOpenChange(false)} />
      <DialogHeader>
        <DialogTitle id="homenet-form-title">홈넷 장치 추가</DialogTitle>
        <DialogDescription>
          월패드가 스스로 등록하는 것이 정상 경로입니다. 이 화면은 월패드가 붙기 전에
          그 세대의 모바일 등록을 열어 둬야 할 때 씁니다.
        </DialogDescription>
      </DialogHeader>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <p className="text-xs text-muted-foreground sm:col-span-2">
          단지는 묻지 않습니다 — 서버가 자기 단지 ID 를 채웁니다.
        </p>

        <div className="grid gap-1.5">
          <Label htmlFor="h-building">동</Label>
          <Input id="h-building" value={form.building} onChange={set('building')} placeholder="101" className="font-mono text-xs" />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="h-unit">호</Label>
          <Input id="h-unit" value={form.unit} onChange={set('unit')} placeholder="805" className="font-mono text-xs" />
        </div>

        <div className="grid gap-1.5 sm:col-span-2">
          <p className="text-xs text-muted-foreground">
            동·호는 영문·숫자·<code>-</code> 8자 이내입니다. 앱은 이 둘을{' '}
            <code className="font-mono">{`${form.building.trim() || '동'}B${form.unit.trim() || '호'}U`}</code>{' '}
            로 보냅니다.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="h-type">종류</Label>
          <Input id="h-type" value={form.type} onChange={set('type')} placeholder="wallpad" />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="h-ip">IP (선택)</Label>
          <Input id="h-ip" value={form.ipaddress} onChange={set('ipaddress')} placeholder="0.0.0.0" className="font-mono text-xs" />
          <p className="text-xs text-muted-foreground">장치가 접속하면 실제 값으로 바뀝니다.</p>
        </div>

        <DialogFooter className="sm:col-span-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            취소
          </Button>
          <Button type="submit" disabled={saving}>{saving ? '저장 중…' : '추가'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
