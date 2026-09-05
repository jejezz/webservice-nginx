import { useEffect, useState } from 'react';
import { AlertCircle, Clock, Loader2, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 로그인 화면의 설정 버튼에서 여는 관리자 로그인 모달.
 * 자격 증명은 서버(/api/admin/login)에서만 검증한다.
 */
export default function AdminLoginDialog({ open, onOpenChange, onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // IP 잠금 카운트다운. Login.jsx 와 같은 방식 — lockedUntil(절대 시각)과 지금
  // 시각의 차이만 매초 다시 계산한다.
  const [lockedUntil, setLockedUntil] = useState(null);
  const [lockRemaining, setLockRemaining] = useState(0);

  useEffect(() => {
    if (!lockedUntil) {
      setLockRemaining(0);
      return undefined;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      setLockRemaining(remaining);
      if (remaining <= 0) setLockedUntil(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const locked = lockRemaining > 0;

  // 닫을 때마다 입력을 비운다. 잠금은 서버 쪽(IP) 얘기라 다이얼로그를 닫아도
  // 실제로 풀리는 건 아니지만, 다시 열면 어차피 처음부터 다시 시도하는
  // 흐름이라 화면 상태도 같이 지운다.
  useEffect(() => {
    if (!open) {
      setUsername('');
      setPassword('');
      setError('');
      setSubmitting(false);
      setLockedUntil(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (locked) return;
    setError('');
    setSubmitting(true);

    try {
      await api.admin.login(username.trim(), password);
      onSuccess();
    } catch (err) {
      if (err.code === 'too_many_attempts') {
        if (typeof err.retryAfterSec === 'number' && err.retryAfterSec > 0) {
          setLockedUntil(Date.now() + err.retryAfterSec * 1000);
        }
        return;
      }
      setError(err.message || '관리자 로그인에 실패했습니다.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} labelledBy="admin-login-title">
      <DialogClose onClick={() => onOpenChange(false)} />

      <DialogHeader>
        <DialogTitle id="admin-login-title" className="flex items-center gap-2">
          <ShieldAlert className="size-4" />
          관리자 로그인
        </DialogTitle>
        <DialogDescription>관리자 계정 관리 콘솔에 들어갑니다.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="admin-username">아이디</Label>
          <Input
            id="admin-username"
            name="admin-username"
            autoComplete="off"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting || locked}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="admin-password">비밀번호</Label>
          <Input
            id="admin-password"
            name="admin-password"
            type="password"
            autoComplete="off"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting || locked}
          />
        </div>

        {locked ? (
          <Alert variant="warning">
            <Clock />
            <AlertDescription>
              시도가 너무 많습니다. <span className="font-mono font-semibold">{lockRemaining}초</span> 뒤 다시
              시도할 수 있습니다.
            </AlertDescription>
          </Alert>
        ) : (
          error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            취소
          </Button>
          <Button type="submit" disabled={submitting || locked}>
            {submitting && <Loader2 className="animate-spin" />}
            {locked ? `${lockRemaining}초 뒤 다시 시도` : '확인'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
