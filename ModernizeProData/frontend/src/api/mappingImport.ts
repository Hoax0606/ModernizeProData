import { api, unwrap, type ApiResponse } from './client';

export interface MappingImport {
  id: string;
  projectId: string;
  filename: string;
  codeFilename: string | null;
  fileSize: number;
  fileHash: string;
  format: string;
  status: string;
  ruleCount: number;
  codeMapCount: number;
  errorMessage: string | null;
  importedBy: string;
  importedAt: string;
}

export interface MappingStatus {
  columnFilename: string | null;
  codeFilename: string | null;
  ruleCount: number;
  codeMapCount: number;
}

export const mappingImportApi = {
  /**
   * Upload column_mapping.csv and/or code_mapping.csv. At least one required.
   * Partial update — each provided file wipes+reinserts its respective table.
   */
  importCsv: (
    projectId: string,
    columnMapping?: File | null,
    codeMapping?: File | null,
  ): Promise<MappingImport> => {
    const fd = new FormData();
    if (columnMapping) fd.append('columnMapping', columnMapping);
    if (codeMapping) fd.append('codeMapping', codeMapping);
    return unwrap(api.post<ApiResponse<MappingImport>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/import`,
      fd,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ));
  },

  /** Import history ordered by importedAt desc (latest first). */
  list: (projectId: string): Promise<MappingImport[]> =>
    unwrap(api.get<ApiResponse<MappingImport[]>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/imports`,
    )),

  /** Current effective state — filenames reflect actual DB content (null when wiped). */
  status: (projectId: string): Promise<MappingStatus> =>
    unwrap(api.get<ApiResponse<MappingStatus>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/status`,
    )),

  /** Wipe all mapping_rules rows for the project. */
  deleteRules: (projectId: string): Promise<void> =>
    unwrap(api.delete<ApiResponse<void>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/rules`,
    )),

  /** Wipe all mapping_code_maps rows for the project. */
  deleteCodeMaps: (projectId: string): Promise<void> =>
    unwrap(api.delete<ApiResponse<void>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/code-maps`,
    )),
};
