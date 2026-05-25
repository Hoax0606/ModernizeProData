/**
 * Time / duration / timestamp format utilities — Scheduler page と Project Settings の Run history で共有.
 */

/** BE "HH:mm:ss" or "HH:mm" → UI "HH:mm". null/undefined / 不正値 → ''. */
export function toHHmm(t: string | null | undefined): string {
  if (!t) return '';
  const parts = t.split(':');
  if (parts.length < 2) return '';
  return `${parts[0]}:${parts[1]}`;
}

/** UI "HH:mm" → BE "HH:mm:ss". 空文字は ''. */
export function toHHmmss(t: string): string {
  if (!t) return '';
  return t.length === 5 ? `${t}:00` : t;
}

/** ISO timestamp → 表示用 (locale 依存). 不正値はそのまま return. */
export function formatTimestamp(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/**
 * Duration (ms) → 人が読める形.
 *   < 1s    → "Xms"
 *   < 1m    → "X.Xs"
 *   < 1h    → "Xm Xs"
 *   それ以上 → "Xh Xm"
 * null/undefined → '-'.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remS = Math.floor(s % 60);
  if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}
