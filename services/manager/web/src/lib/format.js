export function formatUptime(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec}초`;

  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);

  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

export function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ko-KR', { hour12: false });
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined) return '—';
  return `${ms} ms`;
}
