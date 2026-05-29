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

  /**
   * binding 단위 위반 row 전수 parquet — axios 로 blob 받고 filename 까지 파싱해서 반환.
   * `<a href>` 로 새 탭 열기 방식은 BE 4xx (parquet 파일 아직 미생성 / audit stage 미실행 등)
   * 일 때 응답이 새 탭에 빈 페이지로 표시되는 문제가 있어 이 함수로 교체.
   *
   * 에러는 axios 가 그대로 throw — 호출부에서 잡아 toast/alert 처리.
   */
  downloadBinding: async (runId: string, bindingId: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await api.get<Blob>(
      `/api/v1/runs/${runId}/quarantine/${bindingId}/download`,
      { responseType: 'blob' },
    );
    const cd = (res.headers['content-disposition'] ?? res.headers['Content-Disposition']) as string | undefined;
    const m = cd?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const filename = m?.[1] ? decodeURIComponent(m[1]) : `quarantine-${bindingId}.parquet`;
    return { blob: res.data, filename };
  },
};
