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
 * ISO timestamp → "HH:mm:ss.SSS" (ms 精度の時刻のみ. 日付は含めない).
 * Run History drill-down のように同一 run 内 (= 同一日内) の細粒度差分を見たい時に使う.
 * finishedAt - startedAt = durationMs が見て分かる桁数で表示.
 */
export function formatTimeMs(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch { return iso; }
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
