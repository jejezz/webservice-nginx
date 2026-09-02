import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, ShieldAlert } from 'lucide-react';
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

  // 닫을 때마다 입력을 비운다.
  useEffect(() => {
    if (!open) {
      setUsername('');
      setPassword('');
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await api.admin.login(username.trim(), password);
      onSuccess();
    } catch (err) {
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
            disabled={submitting}
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
            disabled={submitting}
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            취소
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            확인
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
