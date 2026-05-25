import { api, unwrap, type ApiResponse } from './client';

/**
 * Run 起動 / 状態取得 / 履歴閲覧 의 API client.
 *
 * - start          : POST /api/v1/runs           (REST 認証 = api_token, master/admin JWT 도 가능)
 * - startAll       : POST /api/v1/runs/all       (schedule_enabled 全 project 일괄)
 * - get            : GET  /api/v1/runs/{id}      (user session)
 * - listByProject  : GET  /api/v1/projects/{id}/runs (user session)
 * - devComplete/devFail : Worker callback シミュレーション (master/admin/worker)
 */

export type RunTypeStr = 'test' | 'rehearsal' | 'cutover';
/**
 * Trigger source 의 가능한 값.
 *   - 新 (Phase 5+): internal / cli / external / manual — 앞으로 모든 새 row 가 이 중 하나
 *   - 旧 (legacy):   nightly / rest / manual_ui — 마이그레이션 이전의 row 가 잔재로 보유.
 *                     표시 専用, 새로 write 되지 않음.
 */
export type TriggerSourceStr =
  | 'internal' | 'cli' | 'external' | 'manual'
  | 'nightly' | 'rest' | 'manual_ui';
export type RunStatusStr = 'pending' | 'running' | 'success' | 'failed' | 'aborted' | 'timed_out';

export interface RunResultDto {
  runId: string | null;
  /** 起動対象の project ID. bulk 結과 / single 結과 모두에 포함. */
  projectId: string | null;
  /** 起動対象の project name. project 가 삭제된 경우 null 가능. */
  projectName: string | null;
  status: 'STARTED' | 'REJECTED' | 'LOCKED';
  reason: string | null;
}

export interface BulkRunResultDto {
  totalProjects: number;
  started: number;
  rejected: number;
  locked: number;
  results: RunResultDto[];
}

export interface RunHistoryDto {
  id: string;
  projectId: string;
  /** BE 가 join 으로 해결한 project name. project 가 삭제된 경우 "(deleted: <id>)". */
  projectName: string;
  runType: RunTypeStr;
  triggerSource: TriggerSourceStr;
  /**
   * 작성 時점에 저장된 raw 텍스트 (감사 로그용).
   * 신규: "Quartz nightly" / "external (default)" / username
   * 과거: "system" / "external:cred-xxx" 등 (그대로 표시)
   */
  requestedBy: string;
  credentialId: string | null;
  /**
   * 이 run 의 책임 worker (= project 의 executionAssignee / assignee 의 username).
   * project 에 assignee 가 미할당이면 null. 실제 분산 실행은 미구현이지만 audit 용으로 기록.
   */
  workerId: string | null;
  status: RunStatusStr;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  snapshotId: string | null;
  batchJobExecutionId: number | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
}

export const runsApi = {
  /**
   * 単一 project 起動. runType 省略時은 BE 가 project.phase 로부터 자동 결정
   * (test / rehearsal / cutover; 그 외 phase 면 REJECTED).
   */
  start: (projectId: string, runType?: RunTypeStr) =>
    unwrap(
      api.post<ApiResponse<RunResultDto>>(
        '/api/v1/runs',
        runType ? { projectId, runType } : { projectId },
      ),
    ),

  startAll: () =>
    unwrap(api.post<ApiResponse<BulkRunResultDto>>('/api/v1/runs/all')),

  get: (runId: string) =>
    unwrap(api.get<ApiResponse<RunHistoryDto>>(`/api/v1/runs/${runId}`)),

  /** 全 project 横断 최근 run 일람 (Dev test page 등에서 사용). */
  listAll: () =>
    unwrap(api.get<ApiResponse<RunHistoryDto[]>>('/api/v1/runs')),

  listByProject: (projectId: string) =>
    unwrap(api.get<ApiResponse<RunHistoryDto[]>>(`/api/v1/projects/${projectId}/runs`)),

  /**
   * DEV: Worker complete callback シミュレーション. PoC dev mode 에서 master/admin 으로 호출 가능.
   * durationMs 는 null 送信 → BE 가 started_at 부터 finished_at 까지 自動算出.
   */
  devComplete: (runId: string) =>
    unwrap(
      api.post<ApiResponse<RunHistoryDto>>(`/api/v1/internal/runs/${runId}/complete`, {
        batchJobExecutionId: null,
        durationMs: null,
      }),
    ),

  /** DEV: Worker fail callback シミュレーション. durationMs 는 BE 自動算出. */
  devFail: (runId: string, errorMessage: string) =>
    unwrap(
      api.post<ApiResponse<RunHistoryDto>>(`/api/v1/internal/runs/${runId}/fail`, {
        batchJobExecutionId: null,
        durationMs: null,
        errorMessage,
        errorCode: 'DEV_FAIL',
      }),
    ),

  /**
   * DEV: run 을 中断 (status=aborted, projects.run_status=idle 復旧).
   * stuck 한 running run 을 깔끔하게 unstick.
   */
  devAbort: (runId: string, reason: string) =>
    unwrap(
      api.post<ApiResponse<RunHistoryDto>>(`/api/v1/internal/runs/${runId}/abort`, {
        reason,
      }),
    ),
};
