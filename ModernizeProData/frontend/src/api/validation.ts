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

/** Validation verdict — 시트 / Overview / 개별 row 의 PASS/FAIL/WARN. */
export type ValidationVerdict = 'PASS' | 'FAIL' | 'WARN';

/** Overview 시트 1 row — "Item / ASIS / TOBE / Verdict" 4 열. */
export interface ValidationOverviewRow {
  item: string;
  asis: string | number | null;
  tobe: string | number | null;
  verdict: ValidationVerdict;
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
}

/** NULL parity 1 row — nullable 컬럼별 NULL 개수 비교. */
export interface ValidationNullParityRow {
  column: string;
  type: string;
  asisNulls: number;
  tobeNulls: number;
  delta: number;
  verdict: ValidationVerdict;
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
}

/** Type validation 1 row — overflow / type mismatch 등 (PoC1 에선 비어있음). */
export interface ValidationTypeValidRow {
  column: string;
  type: string;
  bound: string;
  observedMax: string | number | null;
  overflowRows: number;
  verdict: ValidationVerdict;
}

/** Row count 요약 (Overview 안에도 들어가지만 시트 헤더 표시용 별도 키). */
export interface ValidationRowCount {
  asis: number;
  tobe: number;
  verdict: ValidationVerdict;
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
  rowCount: ValidationRowCount;
  checksum: ValidationChecksum;
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
};
