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
};
