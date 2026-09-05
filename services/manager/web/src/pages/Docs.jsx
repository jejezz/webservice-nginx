import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, ArrowLeft, BookOpen, ExternalLink, FileText, History, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/auth';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// 저장소 루트 기준 경로를 사람이 읽을 그룹 제목으로. 파일 목록을 훑어서
// 만드는 값이라 새 디렉터리가 생겨도 여기를 고칠 일이 없다.
function groupOf(path) {
  if (!path.includes('/')) return '루트';
  if (path.startsWith('docs/')) return '규약 (docs/)';
  const m = path.match(/^services\/([^/]+)\//);
  if (m) return `서비스 — ${m[1]}`;
  const top = path.split('/')[0];
  return top;
}

function DocsBrowser() {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const [contentError, setContentError] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [filter, setFilter] = useState('');
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    api.docs
      .list()
      .then((r) => {
        if (!mounted.current) return;
        setFiles(r.files);
        if (r.files.length) setSelected(r.files[0].path);
      })
      .catch((err) => mounted.current && setError(err.message || '문서 목록을 불러오지 못했습니다.'));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoadingContent(true);
    setContentError('');
    api.docs
      .content(selected)
      .then((r) => mounted.current && setContent(r.content))
      .catch((err) => mounted.current && setContentError(err.message || '문서를 불러오지 못했습니다.'))
      .finally(() => mounted.current && setLoadingContent(false));
  }, [selected]);

  const grouped = useMemo(() => {
    if (!files) return [];
    const q = filter.trim().toLowerCase();
    const matched = q
      ? files.filter((f) => f.path.toLowerCase().includes(q) || f.title.toLowerCase().includes(q))
      : files;

    const groups = new Map();
    for (const f of matched) {
      const g = groupOf(f.path);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files, filter]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!files) return <Skeleton className="h-96" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit lg:sticky lg:top-20">
        <CardContent className="space-y-3 p-3">
          <Input
            placeholder="파일·제목 검색…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 text-xs"
          />
          <nav className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {grouped.map(([group, items]) => (
              <div key={group}>
                <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </p>
                <ul className="space-y-0.5">
                  {items.map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => setSelected(f.path)}
                        className={cn(
                          'block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent',
                          selected === f.path && 'bg-accent font-medium'
                        )}
                        title={f.path}
                      >
                        {f.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {grouped.length === 0 && <p className="px-1 text-xs text-muted-foreground">일치하는 문서가 없습니다.</p>}
          </nav>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          {contentError ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{contentError}</AlertDescription>
            </Alert>
          ) : loadingContent ? (
            <Skeleton className="h-96" />
          ) : (
            <>
              <p className="mb-4 font-mono text-xs text-muted-foreground">{selected}</p>
              <div className="overflow-x-auto">
                <article className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                </article>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ChangelogBrowser() {
  const [scopeOptions, setScopeOptions] = useState(null);
  const [scope, setScope] = useState('');
  const [commits, setCommits] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const load = useCallback((s) => {
    setLoading(true);
    setError('');
    api
      .changelog(s)
      .then((r) => {
        if (!mounted.current) return;
        setCommits(r.commits);
        if (!scopeOptions) setScopeOptions(r.scopes);
      })
      .catch((err) => mounted.current && setError(err.message || '변경 이력을 불러오지 못했습니다.'))
      .finally(() => mounted.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(scope);
  }, [scope, load]);

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">범위</span>
          <Button variant={scope === '' ? 'default' : 'outline'} size="sm" onClick={() => setScope('')}>
            전체
          </Button>
          <Button variant={scope === 'docs' ? 'default' : 'outline'} size="sm" onClick={() => setScope('docs')}>
            docs/
          </Button>
          {(scopeOptions?.services || []).map((s) => (
            <Button key={s} variant={scope === s ? 'default' : 'outline'} size="sm" onClick={() => setScope(s)}>
              {s}
            </Button>
          ))}
          <Button variant="ghost" size="icon" className="ml-auto" onClick={() => load(scope)} disabled={loading}>
            <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!commits ? (
          <Skeleton className="h-96" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>날짜</TableHead>
                  <TableHead>커밋</TableHead>
                  <TableHead>지은이</TableHead>
                  <TableHead>내용</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commits.map((c) => (
                  <TableRow key={c.hash}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(c.date)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.hash}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{c.author}</TableCell>
                    <TableCell className="text-sm">{c.subject}</TableCell>
                  </TableRow>
                ))}
                {commits.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-xs text-muted-foreground">
                      커밋이 없습니다.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Docs() {
  const { logout } = useAuth();
  const [tab, setTab] = useState('docs');

  // 세션 만료는 두 탭 모두 같은 방식으로 처리한다 — 자식이 401 을 던지면
  // 여기서 잡지 않고 자기가 로그인 화면으로 보내므로, 이 컴포넌트는
  // 그냥 logout 을 물려주기만 한다. (지금은 각 브라우저가 자체 처리)
  void logout;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" asChild title="대시보드로">
              <Link to="/dashboard">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <div className="flex size-9 items-center justify-center rounded-lg border bg-card">
              <BookOpen className="size-4" />
            </div>
            <h1 className="text-sm font-semibold leading-tight">문서</h1>
          </div>

          <div className="flex items-center gap-2">
            <Button variant={tab === 'docs' ? 'default' : 'outline'} size="sm" onClick={() => setTab('docs')}>
              <FileText className="size-3.5" />
              <span className="hidden sm:inline">문서</span>
            </Button>
            <Button variant={tab === 'log' ? 'default' : 'outline'} size="sm" onClick={() => setTab('log')}>
              <History className="size-3.5" />
              <span className="hidden sm:inline">변경 이력</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        {tab === 'docs' ? <DocsBrowser /> : <ChangelogBrowser />}

        <p className="pb-4 text-center text-xs text-muted-foreground">
          <ExternalLink className="mr-1 inline size-3" />
          여기 뜨는 문서는 git 이 추적하는 <code className="font-mono">.md</code> 파일 전부입니다 — 비밀·장비별 값(settings.ini·secrets/)은
          이 저장소 관례상 커밋되지 않으므로 애초에 목록에 오르지 않습니다.
        </p>
      </main>
    </div>
  );
}
