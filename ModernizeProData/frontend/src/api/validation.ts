import { api, unwrap, type ApiResponse } from './client';

/**
 * Validation report API — ArtifactsPage 의 Validation 카테고리가 호출.
 *
 * BE: ValidationReportController. Verify 직後의 post-processing 으로 계산된 per-binding
 * aggregate 비교 결과 (Sum recon / NULL parity / Min-Max / Checksum / Row count) 박제물.
 *
 * - listByRun   : 한 run 의 전체 binding (테이블 선택 메뉴 채우기용)
 * - getByBinding: 단일 binding 상세 (Artifacts 페이지 시트 표시용)
 * - getByTable  : TO-BE 物理명 fallback (binding ID 추적이 어려운 경우)
 */

/** Validation verdict — PASS/FAIL/WARN/SKIP.
 *  SKIP = 운영자가 명시 ack 해서 다음 run 부터는 carry-over (정책 3·6). */
export type ValidationVerdict = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

/** Overview 시트 1 row — "Item / ASIS / TOBE / Verdict / Note" 5 열.
 *  Note 는 SKIP 시 ack note (운영자 메모) 또는 WARN 시 canonical-match 안내 텍스트. */
export interface ValidationOverviewRow {
  item: string;
  asis: string | number | null;
  tobe: string | number | null;
  verdict: ValidationVerdict;
  note?: string | null;
}

/** Sum recon 1 row — numeric 컬럼별 SUM 비교. */
export interface ValidationSumReconRow {
  column: string;
  type: string;
  asisSum: string | number | null;
  tobeSum: string | number | null;
  /** "0" / "0.123" / null. 0 division 인 경우 null. */
  deltaPercent: string | number | null;
  verdict: ValidationVerdict;
  note?: string | null;
}

/** NULL parity 1 row — nullable 컬럼별 NULL 개수 비교. */
export interface ValidationNullParityRow {
  column: string;
  type: string;
  asisNulls: number;
  tobeNulls: number;
  delta: number;
  verdict: ValidationVerdict;
  note?: string | null;
}

/** Min/Max 1 row — numeric / date 컬럼별 MIN·MAX 비교. */
export interface ValidationMinMaxRow {
  column: string;
  type: string;
  asisMin: string | number | null;
  asisMax: string | number | null;
  tobeMin: string | number | null;
  tobeMax: string | number | null;
  verdict: ValidationVerdict;
  /** WARN/FAIL 시 BE 가 적은 사유 — 예: "values match in canonical form — display format differs"
   *  또는 "TZ canonical compare unavailable (ICU extension may be missing)" 등. null = 정상. */
  note?: string | null;
}

/** Type validation 1 row — AuditStage 의 row-level validate.range/type/length 격리 결과. */
export interface ValidationTypeValidRow {
  column: string;
  type: string;
  bound: string;
  observedMax: string | number | null;
  overflowRows: number;
  verdict: ValidationVerdict;
  note?: string | null;
}

/** Row count 요약. 2026-05-31: quarantined 필드 추가 — AuditStage 가 위반 row 를 tobe_ 에서
 *  DELETE 한 후 Load 가 PG 적재하므로 expected PG row = ASIS row - quarantined.
 *  verdict 는 보정된 비교 (ASIS - quarantined == TOBE) 기준. */
export interface ValidationRowCount {
  asis: number;
  quarantined: number;
  tobe: number;
  verdict: ValidationVerdict;
}

/** quarantineStats 시트 1 row — stageLabel × (entries count, rows quarantined). */
export interface ValidationQuarantineStatsRow {
  stageLabel: string;
  entries: number;
  rowsQuarantined: number;
  /** 'error' / 'warning' / '' — 같은 stageLabel 안에 둘 다 있으면 'error' 우선. */
  severity?: string;
}

/** Checksum SHA-256 요약. PK 없는 binding 은 asis/tobe 빈 문자열 + verdict='WARN'. */
export interface ValidationChecksum {
  asis: string;
  tobe: string;
  verdict: ValidationVerdict;
}

export interface ValidationReportDto {
  runId: string;
  bindingId: string;
  tobeSchema: string;
  tobeTable: string;
  generatedAt: string;
  totalChecks: number;
  passedChecks: number;
  /** 'success' (정상 계산) / 'failed' (DB 접속 / SQL 오류 등 — 그 binding 만). */
  status: 'success' | 'failed';
  errorSummary: string | null;
  overview: ValidationOverviewRow[];
  sumRecon: ValidationSumReconRow[];
  nullParity: ValidationNullParityRow[];
  minMax: ValidationMinMaxRow[];
  typeValid: ValidationTypeValidRow[];
  /** 2026-05-31 추가 — binding 의 quarantine 통계 (stageLabel × entries / rows). */
  quarantineStats: ValidationQuarantineStatsRow[];
  rowCount: ValidationRowCount;
  checksum: ValidationChecksum;
}

/** Drill-down — Data Integrity Check FAIL 시 어느 row 가 다른지 row-by-row 비교 결과. */
export interface ValidationDiffSampleDto {
  runId: string;
  bindingId: string;
  pkColumns: string[];
  limit: number;
  totalDiff: number;
  /** 운영 메시지 — "no PK" / "TO-BE DB config not set" / "scanned first N rows only" 등. null = 정상. */
  note: string | null;
  rows: ValidationDiffRow[];
}

export interface ValidationDiffRow {
  pk: unknown[];
  status: 'asis-only' | 'tobe-only' | 'value-diff';
  diffs: ValidationColumnDiff[];
}

export interface ValidationColumnDiff {
  column: string;
  asisValue: unknown;
  tobeValue: unknown;
}

export const validationApi = {
  /** 한 run 의 모든 binding 결과 일람. Artifacts 페이지가 Project 선택 시 1회 호출 → 캐시. */
  listByRun: (runId: string) =>
    unwrap(api.get<ApiResponse<ValidationReportDto[]>>(`/api/v1/runs/${runId}/validation`)),

  /** 단일 binding 상세. selectedTable 변경 시 호출. */
  getByBinding: (runId: string, bindingId: string) =>
    unwrap(api.get<ApiResponse<ValidationReportDto>>(
      `/api/v1/runs/${runId}/validation/${bindingId}`,
    )),

  /** TO-BE 物理명 fallback. binding ID 추적이 어려운 경우. */
  getByTable: (runId: string, tobeTable: string) =>
    unwrap(api.get<ApiResponse<ValidationReportDto>>(
      `/api/v1/runs/${runId}/validation/by-table?tobeTable=${encodeURIComponent(tobeTable)}`,
    )),

  /** Drill-down: Data Integrity Check FAIL 시 row-by-row diff 조회. limit 기본 50, 최대 200. */
  getDiffSample: (runId: string, bindingId: string, limit = 50) =>
    unwrap(api.get<ApiResponse<ValidationDiffSampleDto>>(
      `/api/v1/runs/${runId}/validation/${bindingId}/diff-sample?limit=${limit}`,
    )),
};
