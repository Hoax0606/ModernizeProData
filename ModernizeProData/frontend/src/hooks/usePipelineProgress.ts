import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IMessage } from '@stomp/stompjs';
import { runsApi, type RunHistoryDto, type RunStatusStr, type StageView } from '../api/runs';
import { createWebSocket, subscribe } from '../api/ws';
import type { SnapshotExecutionContext } from '../store/snapshots';

/**
 * Run の進捗を BE polling + WebSocket 実時間通知 で監視するフック.
 *
 * - 2 秒間隔の polling (GET /runs/{id} と /runs/{id}/stages) — base layer.
 * - WS subscribe `/topic/run/{id}/progress` — BE LocalWorkerExecutor 가 stage 완료
 *   마다 + RunService.finishRun 이 종료마다 push. 메시지 수신 시 즉시 invalidate
 *   해서 polling 주기보다 빠르게 화면 갱신. **옵션 채널** — STOMP 끊겨도 polling
 *   이 fallback 으로 정상 동작.
 * - run.status が terminal (success / failed / aborted / timed_out) 이면
 *   polling 정지 + WS unsubscribe (의도적 cleanup).
 * - runId が null の間は両 query 共 disabled, WS 도 연결 안 함.
 * - terminal 後も最後のスナップショットは cache に残るので UI は最後の状態を見続けられる.
 *
 * 使用パターン:
 *   const { run, stages } = usePipelineProgress(activeRunId);
 *   // activeRunId が null の間は run / stages も undefined
 */
export function usePipelineProgress(
  runId: string | null,
  /** runId 가 null 일 때 표시할 fallback — 보통 latest mapping snapshot 의 박제된
   *  execution_context. 사용자가 별도 UI 조작 없이도 run 끝난 직후 그 snapshot 의
   *  pipeline 이 자연스럽게 보이게 한다. live polling 보다 항상 후순위. */
  fallback?: SnapshotExecutionContext | null,
) {
  const queryClient = useQueryClient();

  /* polling interval 2s → 4s (2026-05-30) — JavaFX WebView (WebKit ~v608) 가 빠른
     polling + 큰 React tree re-render 누적에서 native crash. WebSocket subscribe 가
     즉시 신호를 받으므로 polling 은 fallback 역할만 — 4s 도 사용자 체감 OK. */
  const runQuery = useQuery<RunHistoryDto>({
    queryKey: ['run', runId],
    enabled: !!runId,
    queryFn: () => runsApi.get(runId!),
    refetchInterval: (q) => (isTerminal(q.state.data?.status) ? false : 4000),
    staleTime: 3500,
  });

  const stagesQuery = useQuery<StageView[]>({
    queryKey: ['run-stages', runId],
    enabled: !!runId,
    queryFn: () => runsApi.stages(runId!),
    refetchInterval: () => (isTerminal(runQuery.data?.status) ? false : 4000),
    staleTime: 3500,
  });

  /* WebSocket 옵션 채널 — STOMP `/topic/run/{id}/progress` 메시지 수신 시 즉시 invalidate.
     terminal 도달 시 onConnect 안에서 unsubscribe (defensive — finishRun broadcast 후
     polling 도 멈추므로 메시지 더 안 옴).
     2026-05-30 — invalidate 4개를 매 신호마다 동시 발사하면 React Query 4개 refetch +
     ExecutionPage 의 큰 tree re-render storm 이 JavaFX WebView (WebKit ~v608) 의 GC 를
     폭주시켜 native access violation crash 유발. 350ms debounce + run-history /
     quarantine 은 polling 에만 맡김 (덜 빈번한 staleness 허용). */
  useEffect(() => {
    if (!runId) return;
    const client = createWebSocket();
    let sub: { unsubscribe(): void } | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const flushInvalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ['run', runId] });
      void queryClient.invalidateQueries({ queryKey: ['run-stages', runId] });
    };

    const scheduleInvalidate = () => {
      if (debounceTimer != null) return; // 이미 예약됨 — 같은 batch 로 묶음
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flushInvalidate();
      }, 350);
    };

    client.onConnect = () => {
      try {
        sub = subscribe(client, `/topic/run/${runId}/progress`, (_body: unknown, _msg: IMessage) => {
          scheduleInvalidate();
        });
      } catch {
        /* subscribe 실패는 무시 — polling 으로 fallback. */
      }
    };
    client.onStompError = () => { /* polling fallback — silent */ };
    client.onWebSocketError = () => { /* polling fallback — silent */ };

    client.activate();
    return () => {
      if (debounceTimer != null) { clearTimeout(debounceTimer); debounceTimer = null; }
      try { sub?.unsubscribe(); } catch { /* ignore */ }
      try { void client.deactivate(); } catch { /* ignore */ }
    };
  }, [runId, queryClient]);

  // runId 가 없고 fallback 만 있으면 frozen snapshot 의 박제본을 RunHistoryDto / StageView[]
  // shape 으로 변환해 그대로 노출. 호출자는 live 인지 frozen 인지 신경 안 써도 된다.
  if (!runId && fallback) {
    return {
      run: snapshotFallbackRun(fallback),
      stages: snapshotFallbackStages(fallback),
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
  }

  return {
    run: runQuery.data,
    stages: stagesQuery.data,
    isLoading: runQuery.isLoading || stagesQuery.isLoading,
    isError: runQuery.isError || stagesQuery.isError,
    refetch: () => {
      void runQuery.refetch();
      void stagesQuery.refetch();
    },
  };
}

/** SnapshotExecutionContext → RunHistoryDto. 미지 필드는 안전한 default. */
function snapshotFallbackRun(ctx: SnapshotExecutionContext): RunHistoryDto {
  return {
    id: ctx.runId,
    projectId: '',
    projectName: '',
    runType: (ctx.runType as RunHistoryDto['runType']),
    triggerSource: 'external',
    requestedBy: '',
    credentialId: null,
    workerId: null,
    status: (ctx.status as RunStatusStr),
    startedAt: ctx.startedAt ?? '',
    finishedAt: ctx.finishedAt,
    durationMs: ctx.durationMs,
    snapshotId: null,
    batchJobExecutionId: null,
    errorMessage: null,
    metadata: {},
  };
}

/** SnapshotExecutionContext.stages → StageView[]. */
function snapshotFallbackStages(ctx: SnapshotExecutionContext): StageView[] {
  return ctx.stages.map((s) => ({
    stageKey: s.stageKey,
    seq: s.seq ?? 0,
    status: (s.status ?? 'pending') as StageView['status'],
    pct: s.pct,
    tablesTotal: s.tablesTotal ?? 0,
    tablesSuccess: s.tablesSuccess ?? 0,
    tablesFailed: s.tablesFailed ?? 0,
    startedAt: s.startedAt ?? undefined,
    finishedAt: s.finishedAt ?? undefined,
    durationMs: s.durationMs ?? undefined,
    errorSummary: s.errorSummary ?? undefined,
    tables: s.tables.map((t) => ({
      tobeTable: t.tobeTable,
      tobeSchema: t.tobeSchema ?? undefined,
      status: (t.status ?? 'running') as 'running' | 'success' | 'failed',
      rowCount: t.rowCount ?? undefined,
      durationMs: t.durationMs ?? undefined,
      errorDetail: typeof t.errorDetail === 'string' ? t.errorDetail : undefined,
      compiledSql: t.compiledSql ?? undefined,
    })),
  }));
}

/** Terminal = polling 停止対象の status. BE 의 RunStatus enum 直接対応. */
export function isTerminal(status?: RunStatusStr | string): boolean {
  return status === 'success' || status === 'failed' || status === 'aborted' || status === 'timed_out';
}
