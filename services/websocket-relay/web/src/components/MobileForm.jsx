import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/**
 * 단말 등록을 만들거나 고치는 폼.
 *
 * 통합 전 무번들 대시보드에만 있던 기능이다. React 화면에는 조회·토글·삭제밖에
 * 없어서, 단말을 손으로 넣으려면 내부 전용 `/mobile-crud-operation` 을 직접
 * 불러야 했다.
 *
 * `record` 가 있으면 수정, 없으면 추가다.
 */

/** 서버가 요구하는 값들 (libs/mobileRecord.ts 의 REQUIRED 와 같다). */
const REQUIRED = ['uuid', 'email', 'complex', 'address', 'token'];

const EMPTY = {
  uuid: '', email: '', complex: '', address: '', token: '',
  phone: '', sip_user: '', active: true,
};

export default function MobileForm({ open, record, onOpenChange, onSaved }) {
  const editing = Boolean(record);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setForm(record
      ? {
          uuid: record.uuid ?? '', email: record.email ?? '',
          complex: record.complex ?? '', address: record.address ?? '',
          // 토큰은 목록 API 가 내려주지 않는다 (FCM 자격이라 싣지 않는다).
          // 비워 두면 건드리지 않고, 값을 넣으면 그때만 바꾼다.
          token: '',
          phone: record.phone ?? '', sip_user: record.sip_user ?? '',
          active: Boolean(record.active),
        }
      : EMPTY);
  }, [open, record]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');

    // 추가할 때만 필수값을 본다. 수정은 보낸 필드만 바꾼다.
    if (!editing) {
      const missing = REQUIRED.filter((k) => !form[k].trim());
      if (missing.length > 0) {
        setError(`${missing.join(', ')} 을(를) 채우세요.`);
        return;
      }
    }

    // 빈 문자열과 '안 보냄' 은 뜻이 다르다.
    //   sip_user = ''  → 내선 연결을 끊는다
    //   token 을 안 보냄 → 기존 토큰을 그대로 둔다
    const body = {
      email: form.email.trim(),
      complex: form.complex.trim(),
      address: form.address.trim(),
      phone: form.phone.trim() || null,
      sip_user: form.sip_user.trim(),
      active: form.active,
    };
    if (!editing) body.uuid = form.uuid.trim();
    if (form.token.trim()) body.token = form.token.trim();

    setSaving(true);
    try {
      if (editing) await api.updateMobile(record.id, body);
      else await api.createMobile(body);
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-lg" labelledBy="mobile-form-title">
      <DialogClose onClick={() => onOpenChange(false)} />
      <DialogHeader>
        <DialogTitle id="mobile-form-title">{editing ? '단말 수정' : '단말 추가'}</DialogTitle>
        <DialogDescription>
          {editing
            ? '비워 둔 FCM 토큰은 건드리지 않습니다.'
            : '앱이 /register 로 스스로 등록하는 것이 정상 경로입니다. 이 화면은 손으로 넣어야 할 때만 씁니다.'}
        </DialogDescription>
      </DialogHeader>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="f-uuid">UUID</Label>
          <Input
            id="f-uuid" value={form.uuid} onChange={set('uuid')}
            disabled={editing} placeholder="단말 고유 ID" className="font-mono text-xs"
          />
          {editing && <p className="text-xs text-muted-foreground">단말의 신원이라 바꾸지 않습니다.</p>}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="f-address">주소 (동/호)</Label>
          <Input id="f-address" value={form.address} onChange={set('address')} placeholder="101-1001" />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="f-email">이메일</Label>
          <Input id="f-email" type="email" value={form.email} onChange={set('email')} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="f-complex">단지 이름</Label>
          <Input id="f-complex" value={form.complex} onChange={set('complex')} />
          {/* 단지 ID(complex_id)는 서버가 자기 값으로 넣는다 — 입력받지 않는다. */}
          <p className="text-xs text-muted-foreground">단지 ID 는 서버가 자기 값으로 채웁니다.</p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="f-phone">전화 (선택)</Label>
          <Input id="f-phone" value={form.phone} onChange={set('phone')} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="f-sip">SIP 내선 (선택)</Label>
          <Input id="f-sip" value={form.sip_user} onChange={set('sip_user')} className="font-mono text-xs" />
          <p className="text-xs text-muted-foreground">
            비우면 인터폰 착신(SIP)을 받지 못합니다. 영문·숫자·<code>. _ -</code> 만.
          </p>
        </div>

        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="f-token">FCM 토큰{editing && ' (바꿀 때만)'}</Label>
          <Input
            id="f-token" value={form.token} onChange={set('token')}
            placeholder={editing ? '비워 두면 그대로' : ''} className="font-mono text-xs"
          />
          {editing && (
            <p className="text-xs text-muted-foreground">
              값을 넣으면 이전 푸시 실패 표시도 함께 지웁니다.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch
            id="f-active" checked={form.active}
            onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))}
          />
          <Label htmlFor="f-active">활성 — 착신 알림(FCM)을 받습니다</Label>
        </div>

        <DialogFooter className="sm:col-span-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            취소
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? '저장 중…' : editing ? '저장' : '추가'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
