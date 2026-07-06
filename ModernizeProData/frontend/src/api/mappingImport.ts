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

/** 사이트 일괄 import 의 프로젝트 1건 결과. BE SiteMappingImportService.ProjectOutcome 와 1:1. */
export interface SiteMappingImportOutcome {
  projectId: string;
  projectName: string;
  status: 'success' | 'failed';
  ruleCount: number;
  codeMapCount: number;
  error: string | null;
}

/** 사이트 일괄 import 집계. BE SiteMappingImportService.SiteImportResult 와 1:1. */
export interface SiteMappingImportResult {
  siteId: string;
  total: number;
  succeeded: number;
  projects: SiteMappingImportOutcome[];
}

export type MappingReportErrorKind = 'EXPRESSION_FAILED' | 'FROM_FAILED' | 'NO_RULES' | 'NO_RULES_LINKED' | 'UNKNOWN';
export type MappingReportErrorType = 'SYNTAX' | 'BINDER' | 'CATALOG' | 'CONVERSION' | 'IO' | 'UNKNOWN';

export interface MappingReportResult {
  tobeSchema: string;
  tobeTable: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
  sql: string | null;
  error: string | null;
  errorKind: MappingReportErrorKind | null;
  errorColumn: string | null;
  errorExpression: string | null;
  errorType: MappingReportErrorType | null;
  /** DuckDB raw 메시지의 첫 줄 — 값/포맷/참조 등 결정적 힌트. */
  errorHint: string | null;
}

/** BE MappingProgressService.ProjectMappingProgress 와 1:1. Site Overview 진행률 집계. */
export interface SiteMappingProgress {
  projectId: string;
  totalTables: number;
  totalColumns: number;
  mappedColumns: number;
  readyTables: number;
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
  /** PG TEXT[] — combine 시 여러 컬럼명. 단일 source 면 원소 1개. */
  asisColumn: string[] | null;
  /** asisColumn 각 원소에 대응하는 AS-IS 타입 (combine 시 다중). */
  asisType: string[] | null;
  strategy: 'expression' | 'null' | 'default' | 'skip';
  transformRule: string | null;
  transformSql: string | null;
  defaultValue: string | null;
  notNullOverride: boolean;
  ruleOrigin: 'imported' | 'manual';
  notes: string | null;
  /** 백엔드 응답에 timestamp 가 포함됨 (이전엔 FE 인터페이스에서 누락). Dashboard Tables 의
   *  Last update 컬럼에서 max(updatedAt ?? createdAt) 으로 사용. */
  createdAt?: string | null;
  updatedAt?: string | null;
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
  /** 자식 link 마킹 — null 이면 자체 정의. 값 있으면 master project_id. */
  sharedFromProjectId?: string | null;
  /** Row N:1 집계 GROUP BY 표현식 — null / blank 이면 GROUP BY 없음. */
  groupByExpr?: string | null;
  /** Row 1:N 펼침 free SQL fragment — null / blank 이면 펼침 없음. */
  expandExpr?: string | null;
}

/* ── Link candidates ─────────────────────────────── */

export interface LinkCandidateOtherTable {
  projectId: string;
  projectName: string;
  tobeSchema: string;
  tobeTable: string;
}

export interface LinkSuggestion {
  tobeSchema: string;
  tobeTable: string;
  currentSharedFromProjectId: string | null;
  candidates: LinkCandidateOtherTable[];
}

export interface LinkParentInfo {
  tobeSchema: string;
  tobeTable: string;
  children: LinkCandidateOtherTable[];
}

export interface LinkCandidatesResponse {
  suggestions: LinkSuggestion[];
  manualOptions: LinkCandidateOtherTable[];
  parentOf: LinkParentInfo[];
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
    tobeTable?: string | null,
  ): Promise<MappingImport> => {
    const fd = new FormData();
    if (columnMapping) fd.append('columnMapping', columnMapping);
    if (codeMapping) fd.append('codeMapping', codeMapping);
    if (tobeTable) fd.append('tobeTable', tobeTable);
    return unwrap(api.post<ApiResponse<MappingImport>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/import`,
      fd,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        // 대형 매핑정의서 (수만 row, DuckDB read_csv + JDBC batch persist) 가 axios
        // global 30s timeout 초과. 10 분 으로 늘림 — runReport 와 동일 정책.
        timeout: 600_000,
      },
    ));
  },

  /**
   * 사이트 단위 일괄 import — 하나의 column/code CSV 를 사이트의 프로젝트들에 분배.
   * projectIds 미지정(빈 배열) = 사이트 전체. 각 프로젝트는 자기 DDL 슬라이스만 가져감.
   */
  importSite: (
    siteId: string,
    projectIds: string[],
    columnMapping?: File | null,
    codeMapping?: File | null,
  ): Promise<SiteMappingImportResult> => {
    const fd = new FormData();
    if (columnMapping) fd.append('columnMapping', columnMapping);
    if (codeMapping) fd.append('codeMapping', codeMapping);
    for (const pid of projectIds) fd.append('projectIds', pid);
    return unwrap(api.post<ApiResponse<SiteMappingImportResult>>(
      `/api/v1/sites/${encodeURIComponent(siteId)}/mapping/import`,
      fd,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        // 사이트 전체 프로젝트 × 대형 매핑정의서 — per-project import 보다 더 길 수 있어 여유.
        timeout: 1_200_000,
      },
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
    /** PG TEXT[] — combine 시 여러 원소. 단일이면 [col] 형태로 전송. */
    asisColumn: string[] | null;
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

  /** Site Overview 진행률 — 프로젝트별 mapped/total 을 BE 가 한 번에 집계 (N×3 호출 대체). */
  siteMappingProgress: (siteId: string): Promise<SiteMappingProgress[]> =>
    unwrap(api.get<ApiResponse<SiteMappingProgress[]>>(
      `/api/v1/sites/${encodeURIComponent(siteId)}/mapping-progress`,
    )),

  /** Rebuild all bindings from current mapping_rules (idempotent — safe to call any time). */
  rebuildBindings: (projectId: string): Promise<number> =>
    unwrap(api.post<ApiResponse<number>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/rebuild-bindings`,
    )),

  /** Re-apply the latest stored CSV content — resets manual rule edits.
   *  tobeTable 지정 시 그 테이블만 재적용. */
  reapplyLatest: (projectId: string, tobeTable?: string | null): Promise<MappingImport> =>
    unwrap(api.post<ApiResponse<MappingImport>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/reapply${tobeTable ? `?tobeTable=${encodeURIComponent(tobeTable)}` : ''}`,
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
      // Trial 의 read_csv + GROUP BY 가 1.4GB 같은 큰 file 에서 30s 넘을 수 있음.
      // axios default (api client.ts) 의 30s timeout 으로는 부족 → 10분 으로 override.
      { params: { tobeSchema, tobeTable, limit }, timeout: 600_000 },
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
    /** 자식 link 마킹 — 값 있으면 sources 무시 + master 의 룰 inherit. null 이면 자체 정의. */
    sharedFromProjectId?: string | null;
    /** Row N:1 집계 GROUP BY 표현식 — null / blank 이면 GROUP BY 없음. */
    groupByExpr?: string | null;
    /** Row 1:N 펼침 free SQL fragment — null / blank 이면 펼침 없음. */
    expandExpr?: string | null;
  }): Promise<MappingTableBindingDto> =>
    unwrap(api.post<ApiResponse<MappingTableBindingDto>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/bindings`,
      payload,
    )),

  /** Link candidates — 자동 추천 + 수동 link UI 용. */
  getLinkCandidates: (projectId: string): Promise<LinkCandidatesResponse> =>
    unwrap(api.get<ApiResponse<LinkCandidatesResponse>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/link-candidates`,
    )),

  /** Wipe all mapping_table_bindings rows for the project. */
  deleteBindings: (projectId: string): Promise<void> =>
    unwrap(api.delete<ApiResponse<void>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/bindings`,
    )),

  /** AS-IS 컬럼 단위 skip 마킹 list. */
  listAsisSkips: (projectId: string): Promise<Array<{ asisSchema: string; asisTable: string; asisColumn: string }>> =>
    unwrap(api.get<ApiResponse<Array<{ asisSchema: string; asisTable: string; asisColumn: string }>>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/asis-skips`,
    )),

  /** AS-IS 컬럼 단위 skip 마킹 upsert. skipped=false 면 마킹 해제. */
  upsertAsisSkip: (projectId: string, payload: {
    asisSchema: string | null;
    asisTable: string;
    asisColumn: string;
    skipped: boolean;
  }): Promise<void> =>
    unwrap(api.post<ApiResponse<void>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/mapping/asis-skips`,
      payload,
    )),
};
