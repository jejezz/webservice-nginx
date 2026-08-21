import { useState } from 'react';
import { AlertCircle, AlertTriangle, KeyRound, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { formatTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** 계정 추가 · 비밀번호 변경에 함께 쓰는 폼. */
function AccountDialog({ open, onOpenChange, mode, account, domains, minLength, maxLength, onSubmit }) {
  const creating = mode === 'create';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 열릴 때마다 초기화한다.
  const reset = (isOpen) => {
    if (isOpen) {
      setUsername(creating ? '' : account?.username || '');
      setDomain(creating ? domains?.[0] || '' : account?.domain || '');
      setPassword('');
      setError('');
    }
    onOpenChange(isOpen);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(creating ? { username, password, domain } : { password });
      reset(false);
    } catch (err) {
      setError(err.message || '실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={reset} labelledBy="account-dialog-title">
      <DialogClose onClick={() => reset(false)} />

      <DialogHeader>
        <DialogTitle id="account-dialog-title">
          {creating ? 'SIP 계정 추가' : `비밀번호 변경 — ${account?.username}`}
        </DialogTitle>
        <DialogDescription>
          {creating
            ? '단말이 REGISTER 할 때 쓸 사용자명과 비밀번호입니다.'
            : '새 비밀번호를 넣으면 인증 해시도 함께 다시 계산됩니다.'}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit}>
        <div className="space-y-4 py-4">
          {creating && (
            <>
              <div className="space-y-2">
                <Label htmlFor="username">사용자명</Label>
                <Input
                  id="username" value={username} autoFocus placeholder="1001"
                  onChange={(e) => setUsername(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  영문·숫자와 <code>.</code> <code>_</code> <code>-</code>, 64자 이내
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="domain">도메인</Label>
                {domains?.length ? (
                  <select
                    id="domain" value={domain} onChange={(e) => setDomain(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    {domains.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                ) : (
                  <Input id="domain" value={domain} onChange={(e) => setDomain(e.target.value)} />
                )}
                <p className="text-xs text-muted-foreground">
                  Kamailio 가 alias 로 아는 도메인만 고를 수 있습니다. 다른 값이면 등록되지 않는 계정이 됩니다.
                </p>
              </div>
            </>
          )}
          <div className="space-y-2">
            <Label htmlFor="password">비밀번호</Label>
            <Input
              id="password" type="password" value={password} autoFocus={!creating}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {minLength}~{maxLength}자. 길이 제한은 Kamailio 가 아니라 이 대시보드의 정책입니다
              (최대값만 <code>subscriber.password</code> 컬럼 크기에서 옵니다).
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => reset(false)} disabled={busy}>취소</Button>
          <Button type="submit" disabled={busy}>{busy ? '처리 중…' : creating ? '추가' : '변경'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export default function Accounts() {
  const { data, error, loading, refreshing, reload } = usePolling(api.accounts, 15000);
  const [dialog, setDialog] = useState(null); // { mode, account }
  const [actionError, setActionError] = useState('');

  if (loading) return <Skeleton className="h-64" />;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const rows = data.accounts || [];

  const remove = async (a) => {
    // 되돌릴 수 없다. 지우면 그 단말은 더 이상 등록할 수 없다.
    if (!window.confirm(`${a.username}@${a.domain} 계정을 삭제할까요?\n이 단말은 더 이상 등록할 수 없게 됩니다.`)) return;
    setActionError('');
    try {
      await api.deleteAccount(a.id);
      reload();
    } catch (err) {
      setActionError(err.message || '삭제하지 못했습니다.');
    }
  };

  return (
    <div className="space-y-4">
      {data.warning && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>{data.warning}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="size-4" />
            SIP 계정
            <Badge variant="outline" className="ml-1 font-normal">{rows.length}</Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{formatTime(data.updatedAt)}</span>
            <Button variant="ghost" size="sm" onClick={reload} disabled={refreshing}>
              <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
            <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
              <Plus className="size-3.5" />
              추가
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">등록된 SIP 계정이 없습니다.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>사용자명</TableHead>
                  <TableHead>도메인</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead className="w-28 text-right">동작</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{a.id}</TableCell>
                    <TableCell className="font-mono text-xs">{a.username}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {a.domain}
                      {data.aliases && !data.aliases.includes(a.domain) && (
                        <Badge variant="destructive" className="ml-2 font-normal">불일치</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {a.canAuthenticate ? (
                        <Badge variant="success" className="font-normal">인증 가능</Badge>
                      ) : (
                        <Badge
                          variant="destructive" className="font-normal"
                          title="평문 password 컬럼이 비어 있어 어떤 비밀번호로도 인증되지 않습니다 (calculate_ha1=yes)"
                        >
                          {a.hashOnly ? '해시만 있음' : '비밀번호 없음'}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost" size="sm" title="비밀번호 변경"
                        onClick={() => setDialog({ mode: 'password', account: a })}
                      >
                        <KeyRound className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" title="삭제" onClick={() => remove(a)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <p className="mt-4 text-xs text-muted-foreground">
            Kamailio 가 아는 도메인:{' '}
            <span className="font-mono">{data.aliases?.length ? data.aliases.join(', ') : '확인 불가'}</span>
            {' · '}비밀번호는 화면에 표시하지 않습니다.
            {' '}<code className="font-mono">kamctl</code> 로도 같은 일을 할 수 있습니다 (accounts.md).
          </p>
        </CardContent>
      </Card>

      <AccountDialog
        open={Boolean(dialog)}
        onOpenChange={(o) => !o && setDialog(null)}
        mode={dialog?.mode}
        account={dialog?.account}
        domains={data.aliases}
        minLength={data.minPasswordLength || 4}
        maxLength={data.maxPasswordLength || 64}
        onSubmit={async (payload) => {
          if (dialog.mode === 'create') await api.createAccount(payload);
          else await api.updateAccount(dialog.account.id, payload);
          reload();
        }}
      />
    </div>
  );
}
