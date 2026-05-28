import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IMessage } from '@stomp/stompjs';
import { runsApi, type RunHistoryDto, type RunStatusStr, type StageView } from '../api/runs';
import { createWebSocket, subscribe } from '../api/ws';

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
export function usePipelineProgress(runId: string | null) {
  const queryClient = useQueryClient();

  const runQuery = useQuery<RunHistoryDto>({
    queryKey: ['run', runId],
    enabled: !!runId,
    queryFn: () => runsApi.get(runId!),
    refetchInterval: (q) => (isTerminal(q.state.data?.status) ? false : 2000),
    staleTime: 1500,
  });

  const stagesQuery = useQuery<StageView[]>({
    queryKey: ['run-stages', runId],
    enabled: !!runId,
    queryFn: () => runsApi.stages(runId!),
    refetchInterval: () => (isTerminal(runQuery.data?.status) ? false : 2000),
    staleTime: 1500,
  });

  /* WebSocket 옵션 채널 — STOMP `/topic/run/{id}/progress` 메시지 수신 시 즉시 invalidate.
     terminal 도달 시 onConnect 안에서 unsubscribe (defensive — finishRun broadcast 후
     polling 도 멈추므로 메시지 더 안 옴). */
  useEffect(() => {
    if (!runId) return;
    const client = createWebSocket();
    let sub: { unsubscribe(): void } | null = null;

    client.onConnect = () => {
      try {
        sub = subscribe(client, `/topic/run/${runId}/progress`, (_body: unknown, _msg: IMessage) => {
          /* payload 무엇이든 invalidate 트리거로 사용. polling 보다 즉시 refetch.
             run-history / quarantine 도 같이 → 활성 run finish 시 history 카운트 + 위반 카드 즉시. */
          void queryClient.invalidateQueries({ queryKey: ['run', runId] });
          void queryClient.invalidateQueries({ queryKey: ['run-stages', runId] });
          void queryClient.invalidateQueries({ queryKey: ['run-history'] });
          void queryClient.invalidateQueries({ queryKey: ['quarantine', runId] });
        });
      } catch {
        /* subscribe 실패는 무시 — polling 으로 fallback. */
      }
    };
    client.onStompError = () => { /* polling fallback — silent */ };
    client.onWebSocketError = () => { /* polling fallback — silent */ };

    client.activate();
    return () => {
      try { sub?.unsubscribe(); } catch { /* ignore */ }
      try { void client.deactivate(); } catch { /* ignore */ }
    };
  }, [runId, queryClient]);

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

/** Terminal = polling 停止対象の status. BE 의 RunStatus enum 直接対応. */
export function isTerminal(status?: RunStatusStr | string): boolean {
  return status === 'success' || status === 'failed' || status === 'aborted' || status === 'timed_out';
}
