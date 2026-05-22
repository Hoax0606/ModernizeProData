import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  runLogApi,
  type RunLogLine,
  type RunLogLevel,
  levelsToParam,
} from '../api/runLogs';
import { useLiveLogStore } from '../store/runLogs';

/**
 * History (off-tail) — keyset paging via useInfiniteQuery.
 * 한 페이지 = 500 라인. 위/아래 sentinel 이 fetchNextPage 호출.
 */
export function useLogsHistory(
  runId: string | null,
  activeLevels: Record<RunLogLevel, boolean>,
  q: string,
) {
  const level = levelsToParam(activeLevels);
  return useInfiniteQuery({
    queryKey: ['run-logs', runId, level ?? 'all', q],
    enabled: !!runId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      runLogApi.list(runId!, { cursor: pageParam, level, q: q || undefined, limit: 500 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    gcTime: 5 * 60_000,
    staleTime: 30_000,
  });
}

/**
 * Live tail — STOMP 구독 + ring buffer.
 *
 * 핵심: query 와 다른 데이터 경로. 화면이 켜져 있는 동안만 subscribe.
 * activeLevels / q 가 바뀌어도 fetch 하지 않고, 받은 라인을 client side 에서 필터링한다
 * (라이브 모드는 양이 적으니 OK; History 모드와 동작이 다름).
 */
export function useLogsStream(
  projectId: string | null,
  enabled: boolean,
  activeLevels: Record<RunLogLevel, boolean>,
  q: string,
): RunLogLine[] {
  const subscribe   = useLiveLogStore((s) => s.subscribeProject);
  const unsubscribe = useLiveLogStore((s) => s.unsubscribeProject);
  const buffer      = useLiveLogStore((s) => (projectId ? s.buffers[projectId] : undefined));

  useEffect(() => {
    if (!enabled || !projectId) return;
    subscribe(projectId);
    return () => {
      unsubscribe(projectId);
    };
  }, [enabled, projectId, subscribe, unsubscribe]);

  return useMemo(() => {
    const raw = buffer ?? [];
    const qLower = q.trim().toLowerCase();
    return raw.filter((l) => {
      const name: RunLogLevel = l.level === 2 ? 'ERROR' : l.level === 1 ? 'WARN' : 'INFO';
      if (!activeLevels[name]) return false;
      if (!qLower) return true;
      return l.message.toLowerCase().includes(qLower) ||
             l.stage.toLowerCase().includes(qLower);
    });
  }, [buffer, activeLevels, q]);
}

/**
 * 선택된 로그의 ±window context. 화면 외 라인도 가져올 수 있어야 하므로
 * 메인 페이지 데이터와 별도 fetch.
 */
export function useLogContext(runId: string | null, seq: number | null, window = 10) {
  return useQuery({
    queryKey: ['run-log-context', runId, seq, window],
    enabled: !!runId && seq != null,
    queryFn: () => runLogApi.around(runId!, seq!, window),
    staleTime: 60_000,
  });
}

/**
 * 카운트 chip — 메타 캐시값 (BE 가 누적 카운터로 들고 있음).
 */
export function useLogCounts(runId: string | null, pollMs?: number) {
  return useQuery({
    queryKey: ['run-log-counts', runId],
    enabled: !!runId,
    queryFn: () => runLogApi.counts(runId!),
    refetchInterval: pollMs ?? false,
    staleTime: 5_000,
  });
}
