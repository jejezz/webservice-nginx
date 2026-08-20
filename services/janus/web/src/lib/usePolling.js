import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';

/**
 * 주기적으로 데이터를 다시 불러온다.
 * 세션이 만료되면(401) manager 로그인으로 보낸다.
 */
export function usePolling(fetcher, intervalMs = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const mounted = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      if (!mounted.current) return;
      setData(result);
      setError('');
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 401) {
        const next = encodeURIComponent(window.location.pathname);
        window.location.href = `${err.payload?.loginUrl || '/manager/login'}?next=${next}`;
        return;
      }
      setError(err.message || '데이터를 불러오지 못했습니다.');
    } finally {
      if (mounted.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!intervalMs) return undefined;
    const timer = setInterval(load, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, load]);

  return { data, error, loading, refreshing, reload: load, setData };
}
