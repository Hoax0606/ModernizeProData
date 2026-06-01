import { api, unwrap, type ApiResponse } from './client';

/**
 * WARN ack 시스템 API client (2026-06-01).
 *
 * BE: QuarantineAckController
 * 정책:
 *   1. WARN 만 있어도 차단 (failed_with_pending_warnings)
 *   2. Scope = per-stageLabel (rule_name + binding_id + reason)
 *   3. Carry-over = fingerprint 기반 (csv_mtime_ms + csv_size 일치 + phase 매칭)
 *   4. Cutover = rehearsal default 채택 + 최종 확인 (분류 quick review)
 */

export type RunPhase = 'test' | 'rehearsal' | 'cutover';

export interface AckRequest {
  projectId: string;
  bindingId: string;
  ruleName: string;
  reason: string;
  csvMtimeMs?: number | null;
  csvSize?: number | null;
  phase: RunPhase;
  note?: string | null;
}

export interface AckResponse {
  acknowledgmentId: number;
  acknowledgedBy: string;
  acknowledgedAt: string;
  phase: RunPhase;
}

export interface AckInfo {
  acknowledgmentId: number;
  acknowledgedBy: string;
  acknowledgedAt: string;
  phase: RunPhase;
  carryOver: boolean;
}

export interface QuarantineGroupAck {
  bindingId: string;
  tableName: string;
  ruleName: string;
  reason: string;
  stageLabel: string;
  severity: 'error' | 'warning';
  rowCount: number;
  entryCount: number;
  ack: AckInfo | null;
}

export interface CutoverReviewGroup {
  bindingId: string;
  ruleName: string;
  reason: string;
  csvMtimeMs?: number | null;
  csvSize?: number | null;
  confirmed: boolean;
}

export interface CutoverReviewRequest {
  groups: CutoverReviewGroup[];
  note?: string | null;
}

export interface CutoverReviewResponse {
  confirmedCount: number;
  rejectedCount: number;
}

export const quarantineAckApi = {
  /** 운영자가 WARN 그룹 명시 ack. */
  acknowledge: (req: AckRequest) =>
    unwrap(api.post<ApiResponse<AckResponse>>('/api/v1/quarantine/acknowledge', req)),

  /** Run 의 quarantine entries 를 group 단위로 + ack 상태 묶어서 조회. */
  listGroups: (runId: string) =>
    unwrap(api.get<ApiResponse<QuarantineGroupAck[]>>(
      `/api/v1/runs/${runId}/quarantine-groups`,
    )),

  /** Cutover 최종 확인 (정책 4 — Rehearsal default + 분류 quick review). */
  confirmCutoverReview: (runId: string, req: CutoverReviewRequest) =>
    unwrap(api.post<ApiResponse<CutoverReviewResponse>>(
      `/api/v1/runs/${runId}/cutover-review/confirm`, req,
    )),
};
