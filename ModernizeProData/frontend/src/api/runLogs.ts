import { api, unwrap, type ApiResponse } from './client';

/* ── Types ──────────────────────────────────────────── */

export type RunLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface RunLogLine {
  seq: number;
  runId: string;
  ts: string;            // ISO offset
  level: number;         // 0=INFO 1=WARN 2=ERROR (raw from BE)
  stage: string;
  message: string;
  // suggestion 필드는 BE worker stage 가 채우지 않아(미래 예약) 항상 null — FE 미사용이라 제거.
}

export interface RunLogPage {
  lines: RunLogLine[];
  nextCursor: string | null;
}

export interface RunLogCounts {
  info: number;
  warn: number;
  error: number;
  total: number;
}

/* ── Helpers ────────────────────────────────────────── */

export function levelName(l: number): RunLogLevel {
  switch (l) {
    case 2: return 'ERROR';
    case 1: return 'WARN';
    default: return 'INFO';
  }
}

export function levelsToParam(active: Record<RunLogLevel, boolean>): string | undefined {
  const on: RunLogLevel[] = (['INFO', 'WARN', 'ERROR'] as const).filter((l) => active[l]);
  if (on.length === 0 || on.length === 3) return undefined;
  return on.join(',');
}

/* ── API ────────────────────────────────────────────── */

export const runLogApi = {
  list: (runId: string, opts: { cursor?: string; level?: string; q?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.level)  params.set('level', opts.level);
    if (opts.q)      params.set('q', opts.q);
    if (opts.limit)  params.set('limit', String(opts.limit));
    return unwrap(api.get<ApiResponse<RunLogPage>>(
      `/api/v1/runs/${runId}/logs?${params.toString()}`,
    ));
  },

  around: (runId: string, seq: number, window = 10) =>
    unwrap(api.get<ApiResponse<RunLogLine[]>>(
      `/api/v1/runs/${runId}/logs/around?seq=${seq}&window=${window}`,
    )),

  one: (runId: string, seq: number) =>
    unwrap(api.get<ApiResponse<RunLogLine>>(`/api/v1/runs/${runId}/logs/${seq}`)),

  counts: (runId: string) =>
    unwrap(api.get<ApiResponse<RunLogCounts>>(`/api/v1/runs/${runId}/logs/counts`)),

  /**
   * CSV 다운로드.
   *
   * `<a href>` / `window.open` 으로는 axios 인터셉터가 안 타서 JWT 가 안 붙는다.
   * axios 로 blob 을 받아 호출부가 직접 anchor click 으로 다운로드를 띄운다.
   * filename 은 BE 의 Content-Disposition 에서 파싱, 없으면 `{runId}.csv` 폴백.
   */
  exportCsv: async (
    runId: string,
    level?: string,
    q?: string,
  ): Promise<{ blob: Blob; filename: string }> => {
    const params = new URLSearchParams();
    if (level) params.set('level', level);
    if (q)     params.set('q', q);
    const qs = params.toString();
    const res = await api.get<Blob>(
      `/api/v1/runs/${runId}/logs/export${qs ? `?${qs}` : ''}`,
      { responseType: 'blob' },
    );
    const cd = (res.headers['content-disposition'] ?? res.headers['Content-Disposition']) as string | undefined;
    const m = cd?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const filename = m?.[1] ? decodeURIComponent(m[1]) : `${runId}.csv`;
    return { blob: res.data, filename };
  },
};
