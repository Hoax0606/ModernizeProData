import { useQuery } from '@tanstack/react-query';
import { runsApi, type RunHistoryDto, type RunStatusStr, type StageView } from '../api/runs';

/**
 * Run の進捗を BE polling で監視するフック.
 *
 * - 2 秒間隔で `GET /runs/{id}` と `GET /runs/{id}/stages` を叩く
 * - run.status が terminal (success / failed / aborted / timed_out) になると
 *   両 query の refetchInterval が `false` を返して停止
 * - runId が null の間は両 query 共 disabled (fetch されない)
 * - terminal 後も最後のスナップショットは cache に残るので UI は最後の状態を見続けられる
 *
 * 使用パターン:
 *   const [activeRunId, setActiveRunId] = useState<string | null>(null);
 *   const { run, stages } = usePipelineProgress(activeRunId);
 *   // activeRunId が null の間は run / stages も undefined
 */
export function usePipelineProgress(runId: string | null) {
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
