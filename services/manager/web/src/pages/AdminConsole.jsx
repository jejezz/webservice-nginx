import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const ROLES = ['admin', 'viewer'];
const MIN_PASSWORD_LENGTH = 8;

/** 행 편집용 초안. 비어 있는 비밀번호는 "바꾸지 않음"을 뜻한다. */
function draftFrom(row) {
  return {
    email: row.email,
    displayName: row.displayName || '',
    role: row.role || 'admin',
    password: '',
  };
}

function CreateDialog({ open, onOpenChange, onCreate }) {
  const [form, setForm] = useState({ email: '', displayName: '', role: 'admin', password: '', approved: true });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setForm({ email: '', displayName: '', role: 'admin', password: '', approved: true });
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
      return;
    }

    setSubmitting(true);
    try {
      await onCreate({
        email: form.email.trim(),
        displayName: form.displayName.trim() || null,
        role: form.role,
        password: form.password,
        approved: form.approved,
      });
    } catch (err) {
      setError(err.message || '추가하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} labelledBy="create-admin-title">
      <DialogClose onClick={() => onOpenChange(false)} />

      <DialogHeader>
        <DialogTitle id="create-admin-title">관리자 추가</DialogTitle>
        <DialogDescription>승인 여부는 나중에 표에서 바로 바꿀 수 있습니다.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="new-email">이메일</Label>
          <Input
            id="new-email"
            type="email"
            required
            placeholder="you@example.com"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            disabled={submitting}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="new-name">표시 이름</Label>
          <Input
            id="new-name"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            disabled={submitting}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="new-role">권한</Label>
          <select
            id="new-role"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            disabled={submitting}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="new-password">비밀번호</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            disabled={submitting}
          />
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="new-approved"
            checked={form.approved}
            onCheckedChange={(v) => setForm({ ...form, approved: v })}
            disabled={submitting}
          />
          <Label htmlFor="new-approved" className="cursor-pointer text-sm font-normal">
            바로 승인 (끄면 승인 대기 상태로 만듭니다)
          </Label>
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
            추가
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function PasswordDialog({ target, onOpenChange, onSubmit }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setValue('');
    setError('');
    setSubmitting(false);
  }, [target]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (value.length < MIN_PASSWORD_LENGTH) {
      setError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(value);
    } catch (err) {
      setError(err.message || '비밀번호를 바꾸지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange} labelledBy="pw-title">
      <DialogClose onClick={() => onOpenChange(false)} />

      <DialogHeader>
        <DialogTitle id="pw-title">비밀번호 변경</DialogTitle>
        <DialogDescription>{target?.email}</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="reset-password">새 비밀번호</Label>
          <Input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={value}
            onChange={(e) => setValue(e.target.value)}
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
            변경
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ target, onOpenChange, onConfirm }) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setError('');
    setSubmitting(false);
  }, [target]);

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(err.message || '삭제하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange} labelledBy="delete-title">
      <DialogHeader>
        <DialogTitle id="delete-title">삭제할까요?</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{target?.email}</span> 계정을 지웁니다. 되돌릴 수 없습니다.
        </DialogDescription>
      </DialogHeader>

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
        <Button type="button" variant="destructive" onClick={handleConfirm} disabled={submitting}>
          삭제
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export default function AdminConsole() {
  const navigate = useNavigate();

  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  // 관리자 세션이 끊기면(만료·로그아웃) 로그인 화면으로 돌린다.
  const bounce = useCallback(() => {
    navigate('/login', { replace: true });
  }, [navigate]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api.admin.list();
      if (!mounted.current) return;
      setRows(data.administrators);
      setError('');
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 401) return bounce();
      setError(err.message || '목록을 불러오지 못했습니다.');
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [bounce]);

  useEffect(() => {
    load();
  }, [load]);

  /** 한 행을 갱신하고 결과를 표에 반영한다. */
  const patch = useCallback(
    async (id, body) => {
      setBusyId(id);
      setError('');
      try {
        const { administrator } = await api.admin.update(id, body);
        if (!mounted.current) return;
        setRows((prev) => prev.map((r) => (r.id === id ? administrator : r)));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return bounce();
        setError(err.message || '변경하지 못했습니다.');
        throw err;
      } finally {
        if (mounted.current) setBusyId(null);
      }
    },
    [bounce]
  );

  function startEdit(row) {
    setEditingId(row.id);
    setDraft(draftFrom(row));
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  async function saveEdit(row) {
    const body = {};
    if (draft.email.trim() !== row.email) body.email = draft.email.trim();
    if ((draft.displayName.trim() || null) !== (row.displayName || null)) {
      body.displayName = draft.displayName.trim() || null;
    }
    if (draft.role !== row.role) body.role = draft.role;

    if (Object.keys(body).length === 0) {
      cancelEdit();
      return;
    }

    try {
      await patch(row.id, body);
      cancelEdit();
    } catch {
      // 오류 메시지는 patch 가 이미 표시했다. 편집 상태는 유지한다.
    }
  }

  async function handleCreate(payload) {
    const { administrator } = await api.admin.create(payload);
    if (!mounted.current) return;
    setRows((prev) => [...prev, administrator]);
    setCreating(false);
  }

  async function handleResetPassword(value) {
    await patch(passwordTarget.id, { password: value });
    if (mounted.current) setPasswordTarget(null);
  }

  async function handleDelete() {
    const id = deleteTarget.id;
    setBusyId(id);
    try {
      await api.admin.remove(id);
      if (!mounted.current) return;
      setRows((prev) => prev.filter((r) => r.id !== id));
      setDeleteTarget(null);
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  async function handleLogout() {
    try {
      await api.admin.logout();
    } finally {
      bounce();
    }
  }

  const pending = rows?.filter((r) => !r.approved).length ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg border bg-card">
              <ShieldAlert className="size-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">관리자 콘솔</h1>
              <p className="text-xs text-muted-foreground">
                administrator 테이블
                {rows ? ` · 총 ${rows.length}명 · 승인 대기 ${pending}명` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
              <span className="hidden sm:inline">새로고침</span>
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">관리자 추가</span>
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout} title="콘솔 나가기">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">관리자 계정</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!rows ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                등록된 관리자가 없습니다. “관리자 추가”로 만들거나, 로그인 화면에서 이메일로 한 번
                시도하면 승인 요청이 만들어집니다.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">ID</TableHead>
                    <TableHead>이메일</TableHead>
                    <TableHead>이름</TableHead>
                    <TableHead className="w-28">권한</TableHead>
                    <TableHead className="w-32">승인</TableHead>
                    <TableHead className="hidden lg:table-cell">요청</TableHead>
                    <TableHead className="hidden lg:table-cell">마지막 로그인</TableHead>
                    <TableHead className="w-16 text-right">횟수</TableHead>
                    <TableHead className="w-32 text-right">작업</TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {rows.map((row) => {
                    const editing = editingId === row.id;
                    const busy = busyId === row.id;

                    return (
                      <TableRow key={row.id} className={cn(busy && 'opacity-60')}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{row.id}</TableCell>

                        <TableCell className="font-mono text-xs">
                          {editing ? (
                            <Input
                              type="email"
                              className="h-8"
                              value={draft.email}
                              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                            />
                          ) : (
                            row.email
                          )}
                        </TableCell>

                        <TableCell className="text-sm">
                          {editing ? (
                            <Input
                              className="h-8"
                              placeholder="—"
                              value={draft.displayName}
                              onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                            />
                          ) : (
                            row.displayName || <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>

                        <TableCell>
                          {editing ? (
                            <select
                              value={draft.role}
                              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <Badge variant="outline">{row.role}</Badge>
                          )}
                        </TableCell>

                        {/* 승인은 편집 모드와 무관하게 바로 바꿀 수 있다. */}
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={row.approved}
                              disabled={busy}
                              onCheckedChange={(value) => patch(row.id, { approved: value }).catch(() => {})}
                              aria-label={`${row.email} 승인`}
                            />
                            <span
                              className={cn(
                                'text-xs',
                                row.approved ? 'text-success' : 'text-muted-foreground'
                              )}
                            >
                              {row.approved ? '승인' : '대기'}
                            </span>
                          </div>
                        </TableCell>

                        <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                          {formatDateTime(row.requestedAt)}
                        </TableCell>

                        <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                          {row.lastLoginAt ? formatDateTime(row.lastLoginAt) : '—'}
                        </TableCell>

                        <TableCell className="text-right font-mono text-xs">{row.loginCount}</TableCell>

                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {editing ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  title="저장"
                                  disabled={busy}
                                  onClick={() => saveEdit(row)}
                                >
                                  <Check className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  title="취소"
                                  onClick={cancelEdit}
                                >
                                  <X className="size-4" />
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  title="수정"
                                  disabled={busy}
                                  onClick={() => startEdit(row)}
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  title="비밀번호 변경"
                                  disabled={busy}
                                  onClick={() => setPasswordTarget(row)}
                                >
                                  <span className="text-xs font-semibold">••</span>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 text-destructive hover:text-destructive"
                                  title="삭제"
                                  disabled={busy}
                                  onClick={() => setDeleteTarget(row)}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <p className="pb-4 text-center text-xs text-muted-foreground">
          승인 스위치를 끄면 해당 계정은 즉시 로그인할 수 없습니다. 모든 변경은{' '}
          <code className="font-mono">admin_audit_log</code>에 기록됩니다.
        </p>
      </main>

      <CreateDialog open={creating} onOpenChange={setCreating} onCreate={handleCreate} />
      <PasswordDialog
        target={passwordTarget}
        onOpenChange={() => setPasswordTarget(null)}
        onSubmit={handleResetPassword}
      />
      <DeleteDialog
        target={deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
