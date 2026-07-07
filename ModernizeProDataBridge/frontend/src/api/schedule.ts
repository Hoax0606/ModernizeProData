import { api, unwrap, type ApiResponse } from './client';
import type { Project } from '../store/workspace';

/**
 * Project 별 schedule_start_time 의 BE 連携.
 * Phase 5: max_duration_min 가 削除됨 (auto-abort 폐지). Internal mode=individual 時만 효과 있음.
 *
 * PATCH /api/v1/projects/{id}/schedule
 *   - startTime 갱신 (Individual mode 時 — Quartz Trigger 도 동일 transaction 에서 reschedule)
 *   - Response 는 갱신된 Project 전체 (schedule_next_run_at 가 계산되어 있음)
 */
export interface UpdateScheduleRequest {
  /** "HH:mm" 또는 "HH:mm:ss" 형식. */
  startTime?: string;
  /** true 로 보내면 startTime 을 NULL 로 clear (이 project 가 스케줄러에서 빠짐). */
  clearStartTime?: boolean;
}

export const scheduleApi = {
  update: (projectId: string, payload: UpdateScheduleRequest) =>
    unwrap(api.patch<ApiResponse<Project>>(`/api/v1/projects/${projectId}/schedule`, payload)),
};
