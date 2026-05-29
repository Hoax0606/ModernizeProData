import { api, unwrap, type ApiResponse } from './client';

/**
 * Run 起動 / 状態取得 / 履歴閲覧 의 API client.
 *
 * - start          : POST /api/v1/runs           (REST 認証 = api_token, master/admin JWT 도 가능)
 * - startAll       : POST /api/v1/runs/all       (siteId 必須 — その site 의 全 project 일괄)
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

/** 1 stage 中の 1 テーブル処理結果 (BE: StageTableResult). */
export interface TableResultView {
  tobeTable: string;
  tobeSchema?: string;
  status: 'running' | 'success' | 'failed';
  rowCount?: number;
  durationMs?: number;
  errorDetail?: string;
  /** TransformStage 가 박제한 CREATE OR REPLACE TABLE ... AS SELECT ... 텍스트.
   *  transform 외 stage 는 null. ArtifactsPage 의 MIGRATION SQL 카테고리에서 표시. */
  compiledSql?: string;
}

/** 1 run の 1 stage の進捗 (BE: StageView, GET /api/v1/runs/{id}/stages の戻り値要素). */
export interface StageView {
  stageKey: string;
  seq: number;
  status: 'pending' | 'running' | 'success' | 'failed';
  /** 0-100. BE が tables_success/tables_total から算出 (or 単純 100/0). */
  pct: number;
  tablesTotal: number;
  tablesSuccess: number;
  tablesFailed: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  errorSummary?: string;
  tables: TableResultView[];
}

/**
 * Versions 画面の Request Review ゲート用の per-project run readiness.
 * BE: GET /api/v1/projects/{id}/run-readiness.
 *
 * allReady: 全 TO-BE テーブルの最新 run が success の時のみ true.
 *   FE 側は allReady=true でないと Request Review ボタンが押せない.
 */
export interface ProjectRunReadinessDto {
  allReady: boolean;
  totalTables: number;
  completedTables: number;
  /** まだ一度も run に含まれた事のない TO-BE テーブル名. */
  notRunTables: string[];
  /** 最新 run が success 以外 (failed/aborted/timed_out) の TO-BE テーブル名. */
  failedTables: string[];
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
  /**
   * 部分実行の TO-BE 物理テーブル名一覧. null = 全 binding 対象 run.
   * metadata.selectedTables の型付き写し. Run History 表でこの値を表示.
   */
  tables: string[] | null;
  /**
   * Run History drill-down 用の table 別件数サマリ. stage_table_results を tobe_table
   * 単位に集約した success / failed / running 件数. まだ stage 結果が無い run は 0/0/0/0.
   * 一覧行に "4 tables: 3✓ 1✗" のような badge を出す材料.
   */
  tableSummary: RunTableSummary;
  metadata: Record<string, unknown>;
}

/** Run History 一覧用の 1 run の table 件数サマリ. */
export interface RunTableSummary {
  total: number;
  success: number;
  failed: number;
  running: number;
}

/**
 * Run History drill-down 行展開時に取得する per-table 詳細.
 * BE: GET /api/v1/runs/{id}/table-results (RunTableResultsService.TableResultDto)
 *
 * 時間系は wall-clock per table:
 *   - startedAt  = 最初に処理した stage の startedAt (= min)
 *   - finishedAt = 最後に処理した stage の finishedAt (= max). 未完了なら null
 *   - durationMs = finishedAt - startedAt. その間に他テーブルの処理が挟まる可能性が
 *                  あるので、合計が run-level duration と一致しないことに注意.
 *
 * エラー情報は含まない — Quarantine タブで個別表示するため重複を避ける.
 */
export interface RunTableResult {
  tobeSchema: string;
  tobeTable: string;
  status: 'success' | 'failed' | 'running';
  rows: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export const runsApi = {
  /**
   * 単一 project 起動. runType 省略時은 BE 가 project.phase 로부터 자동 결정
   * (test / rehearsal / cutover; 그 외 phase 면 REJECTED).
   *
   * tables: 部分実行用. TO-BE 物理名の配列を渡すと、その binding だけが処理される.
   * 未指定 (undefined / 空配列) なら BE は全 binding を処理. BE が tables を未対応の
   * 期間でも互換性あり (フィールド無視されるだけ).
   */
  start: (projectId: string, runType?: RunTypeStr, tables?: string[],
          opts?: { resumeFromRunId?: string; useCache?: boolean }) =>
    unwrap(
      api.post<ApiResponse<RunResultDto>>(
        '/api/v1/runs',
        {
          projectId,
          ...(runType ? { runType } : {}),
          ...(tables && tables.length > 0 ? { tables } : {}),
          ...(opts?.resumeFromRunId ? { resumeFromRunId: opts.resumeFromRunId } : {}),
          ...(opts?.useCache ? { useCache: true } : {}),
        },
      ),
    ),

  /**
   * 進行中 / 終了済 run の stage 単位の進捗を取得. 2 秒 polling 想定.
   * Terminal 状態 (run.status が success/failed/aborted/timed_out) になったら呼び元が
   * polling を止める.
   */
  stages: (runId: string) =>
    unwrap(api.get<ApiResponse<StageView[]>>(`/api/v1/runs/${runId}/stages`)),

  /**
   * run の中断. status を 'aborted' に遷移させる (実行中 thread の強制中断は PoC 2 次).
   * BE 側 abort endpoint が public で着くまでは 4xx になり得るので、呼び元は失敗を許容.
   */
  abort: (runId: string, reason?: string) =>
    unwrap(api.post<ApiResponse<RunHistoryDto>>(
      `/api/v1/runs/${runId}/abort`,
      reason ? { reason } : {},
    )),

  // pause / resume 제거 (2026-05-29). Stop + Retry (resume-from-failed-stage) 가 기능 동치.

  /**
   * 指定 site の全 project 一斉起動. siteId 必須 (2026-05-29 仕様変更で必須化).
   * 旧仕様の「全 site 横断 findAll」は誤発火事故防止のため廃止.
   */
  startAll: (siteId: string) =>
    unwrap(api.post<ApiResponse<BulkRunResultDto>>('/api/v1/runs/all', { siteId })),

  get: (runId: string) =>
    unwrap(api.get<ApiResponse<RunHistoryDto>>(`/api/v1/runs/${runId}`)),

  /** 全 project 横断 최근 run 일람 (Dev test page 등에서 사용). */
  listAll: () =>
    unwrap(api.get<ApiResponse<RunHistoryDto[]>>('/api/v1/runs')),

  listByProject: (projectId: string) =>
    unwrap(api.get<ApiResponse<RunHistoryDto[]>>(`/api/v1/projects/${projectId}/runs`)),

  /**
   * Versions 画面の Request Review ゲート判定. BE が project の全 TO-BE テーブル
   * について「最新 run の status」を集計して返す.
   */
  runReadiness: (projectId: string) =>
    unwrap(api.get<ApiResponse<ProjectRunReadinessDto>>(`/api/v1/projects/${projectId}/run-readiness`)),

  /**
   * Run History drill-down — 1 run の per-table 詳細結果. 行展開時に取得.
   */
  tableResults: (runId: string) =>
    unwrap(api.get<ApiResponse<RunTableResult[]>>(`/api/v1/runs/${runId}/table-results`)),

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
