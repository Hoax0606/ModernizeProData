import { api, unwrap, type ApiResponse } from './client';
import type { QuarantineGroup, SiteQuarantineGroup } from '../pages/quarantineMock';

/* ── API ────────────────────────────────────────────── */

export const quarantineApi = {
  /** Run 1 회분의 quarantine group. LogViewerPage 의 quarantine 탭. */
  byRun: (runId: string) =>
    unwrap(api.get<ApiResponse<QuarantineGroup[]>>(
      `/api/v1/runs/${runId}/quarantine`,
    )),

  /** Site 의 모든 project 의 최근 run 의 quarantine. SiteQuarantinePage. */
  bySite: (siteId: string) =>
    unwrap(api.get<ApiResponse<SiteQuarantineGroup[]>>(
      `/api/v1/sites/${siteId}/quarantine`,
    )),

  /** binding 단위 위반 row 전수 parquet 다운로드 URL. <a href> 또는 fetch blob 으로 사용. */
  downloadUrl: (runId: string, bindingId: string) =>
    `/api/v1/runs/${runId}/quarantine/${bindingId}/download`,
};
