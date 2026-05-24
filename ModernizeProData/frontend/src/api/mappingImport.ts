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

export interface MappingReportResult {
  tobeSchema: string;
  tobeTable: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
  sql: string | null;
  error: string | null;
}

export interface MappingTableBindingSourceDto {
  id: string;
  ordinal: number;
  asisSchema: string | null;
  asisTable: string;
  alias: string;
  role: 'primary' | 'join' | 'union';
  joinType: string | null;
  joinOn: string | null;
}

export interface MappingRuleDto {
  id: string;
  projectId: string;
  importId: string | null;
  tobeSchema: string;
  tobeTable: string;
  tobeColumn: string;
  asisSchema: string | null;
  asisTable: string | null;
  asisColumn: string | null;
  strategy: 'expression' | 'null' | 'default' | 'skip';
  transformRule: string | null;
  transformSql: string | null;
  defaultValue: string | null;
  notNullOverride: boolean;
  ruleOrigin: 'imported' | 'manual';
  notes: string | null;
}

export interface MappingTableBindingDto {
  id: string;
  projectId: string;
  importId: string | null;
  tobeSchema: string;
  tobeTable: string;
  compositionKind: 'single' | 'join' | 'union' | 'none';
  whereFilter: string | null;
  bindingOrigin: 'imported' | 'manual';
  createdBy: string;
  createdAt: string;
  sources: MappingTableBindingSourceDto[];
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

  /** List all mapping_rules rows for the project. */
  listRules: (projectId: string): Promise<MappingRuleDto[]> =>
    unwrap(api.get<ApiResponse<MappingRuleDto[]>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/rules`,
    )),

  /** Upsert one mapping_rules row (column-level rule edit from row editor). */
  upsertRule: (projectId: string, payload: {
    tobeSchema: string;
    tobeTable: string;
    tobeColumn: string;
    asisSchema: string | null;
    asisTable: string | null;
    asisColumn: string | null;
    strategy: 'expression' | 'null' | 'default' | 'skip';
    transformRule: string | null;
    transformSql: string | null;
    defaultValue: string | null;
    notNullOverride: boolean;
  }): Promise<MappingRuleDto> =>
    unwrap(api.post<ApiResponse<MappingRuleDto>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/rules`,
      payload,
    )),

  /** Wipe all mapping_code_maps rows for the project. */
  deleteCodeMaps: (projectId: string): Promise<void> =>
    unwrap(api.delete<ApiResponse<void>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/code-maps`,
    )),

  /** Table-level bindings (TO-BE ← AS-IS, with alias/role/join). */
  listBindings: (projectId: string): Promise<MappingTableBindingDto[]> =>
    unwrap(api.get<ApiResponse<MappingTableBindingDto[]>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/bindings`,
    )),

  /** Rebuild all bindings from current mapping_rules (idempotent — safe to call any time). */
  rebuildBindings: (projectId: string): Promise<number> =>
    unwrap(api.post<ApiResponse<number>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/rebuild-bindings`,
    )),

  /** Re-apply the latest stored CSV content — resets manual rule edits. */
  reapplyLatest: (projectId: string): Promise<MappingImport> =>
    unwrap(api.post<ApiResponse<MappingImport>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/reapply`,
    )),

  /**
   * Run the mapping report — generates SELECT SQL from rules + binding,
   * executes via DuckDB on the AS-IS CSV files, returns transformed rows.
   */
  runReport: (
    projectId: string,
    tobeSchema: string,
    tobeTable: string,
    limit = 20,
  ): Promise<MappingReportResult> =>
    unwrap(api.get<ApiResponse<MappingReportResult>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/report`,
      { params: { tobeSchema, tobeTable, limit } },
    )),

  /** Upsert one TO-BE table's binding (manual edit from UI). */
  upsertBinding: (projectId: string, payload: {
    tobeSchema: string;
    tobeTable: string;
    compositionKind: 'single' | 'join' | 'union' | 'none';
    whereFilter: string | null;
    sources: Array<{
      ordinal: number;
      asisSchema: string | null;
      asisTable: string;
      alias: string;
      role: 'primary' | 'join' | 'union';
      joinType: string | null;
      joinOn: string | null;
    }>;
  }): Promise<MappingTableBindingDto> =>
    unwrap(api.post<ApiResponse<MappingTableBindingDto>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/bindings`,
      payload,
    )),

  /** Wipe all mapping_table_bindings rows for the project. */
  deleteBindings: (projectId: string): Promise<void> =>
    unwrap(api.delete<ApiResponse<void>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/bindings`,
    )),
};
