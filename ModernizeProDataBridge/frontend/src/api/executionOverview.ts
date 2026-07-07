import { api, unwrap, type ApiResponse } from './client';

/**
 * Execution overview 의 per-row pipeline 7-bar 描画用 stage 集約.
 * BE: ExecutionOverviewService.StageSummary. api/runs.ts:StageView と互換 (tables 詳細省略).
 */
export interface ExecStageSummary {
  stageKey: string;
  seq: number;
  status: string;          // pending / running / success / failed
  pct: number;             // 0-100, tablesSuccess/tablesTotal 比
  tablesTotal: number;
  tablesSuccess: number;
  tablesFailed: number;
}

/**
 * Execution overview (All projects 화면, /site/execution) 의 per-project 실행 지표.
 * BE: GET /api/v1/sites/{siteId}/execution-overview (ExecutionOverviewController).
 */
export interface ProjectExecMetrics {
  projectId: string;
  projectName: string;
  latestRunId: string | null;
  runStatus: string | null;   // pending/running/paused/success/failed/aborted/timed_out, or null (run 이력 없음)
  rows: number;
  tablesTotal: number;
  tablesDone: number;
  errorCount: number;
  warningCount: number;
  /** 운영자가 명시 ack 한 WARN entry 수 — "M/N 처리" 분수 표시용. */
  warningAckedCount: number;
  progressPct: number;
  /**
   * 7-stage の現在状態. 空配列 = run 履歴なし. FE はこれを buildStagesFromStageViews に
   * 渡して Execution 画面と同じレンダラで bar を描く (progressPct→floor() による桁ずれ排除).
   */
  stages: ExecStageSummary[];
}

export const overviewApi = {
  bySite: (siteId: string) =>
    unwrap(api.get<ApiResponse<ProjectExecMetrics[]>>(`/api/v1/sites/${siteId}/execution-overview`)),
};
