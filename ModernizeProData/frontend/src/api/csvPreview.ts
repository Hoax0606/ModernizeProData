import { api, unwrap, type ApiResponse } from './client';

export interface CsvPreview {
  table: string;
  resolvedPath: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
}

export const csvPreviewApi = {
  /**
   * Fetch a preview of {csvPath}/{tableName}.csv for the given site.
   * Backend resolves the file under the site's configured csvPath,
   * parses up to `limit` data rows (header excluded) and returns rows as string arrays.
   */
  forTable: (siteId: string, tableName: string, limit = 50): Promise<CsvPreview> =>
    unwrap(api.get<ApiResponse<CsvPreview>>(
      `/api/v1/sites/${encodeURIComponent(siteId)}/csv-preview/${encodeURIComponent(tableName)}`,
      { params: { limit } },
    )),

  /** AS-IS csv 의 data row 수 (header 제외). Mapping page tree 표시용. 1.4GB 도 line count ~15초. */
  rowCount: (siteId: string, tableName: string): Promise<{ table: string; rowCount: number }> =>
    unwrap(api.get<ApiResponse<{ table: string; rowCount: number }>>(
      `/api/v1/sites/${encodeURIComponent(siteId)}/csv-row-count/${encodeURIComponent(tableName)}`,
      { timeout: 120_000 },
    )),
};
