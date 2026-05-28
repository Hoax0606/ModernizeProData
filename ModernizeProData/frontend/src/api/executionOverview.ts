import { api, unwrap, type ApiResponse } from './client';

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
  progressPct: number;
}

export const overviewApi = {
  bySite: (siteId: string) =>
    unwrap(api.get<ApiResponse<ProjectExecMetrics[]>>(`/api/v1/sites/${siteId}/execution-overview`)),
};
