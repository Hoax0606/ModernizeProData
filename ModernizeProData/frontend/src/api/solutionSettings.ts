import { api, unwrap, type ApiResponse } from './client';

/**
 * Solution-level configuration (BE 의 solution_settings 단일 행).
 * Solution Settings Modal 의 External integrations 가 이 endpoint 를 사용.
 */
/** Internal scheduler mode (Phase 5). 'common' = 全 project 共通時刻 / 'individual' = project ごと. */
export type InternalMode = 'common' | 'individual';

export interface SolutionSettingsDto {
  id: number;
  /** 内部 (Quartz Nightly) 활성화. external 와 mutex. */
  internalEnabled: boolean;
  /** internal_enabled=true 時 의 mode. NULL 면 mode 未選択 (Save 不可 状態). */
  internalMode: InternalMode | null;
  /** mode="common" 時 의 共通 발화 시각 (HH:mm[:ss]). */
  internalCommonTime: string | null;
  externalEnabled: boolean;
  /** 外部スケジューラ / curl がアクセスする本ツール URL. Trigger examples docs に embed される. */
  externalApiEndpoint: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface UpdateSolutionSettingsRequest {
  internalEnabled?: boolean;
  internalMode?: InternalMode | null;
  internalCommonTime?: string | null;
  externalEnabled?: boolean;
  externalApiEndpoint?: string;
}

export const solutionSettingsApi = {
  get: () =>
    unwrap(api.get<ApiResponse<SolutionSettingsDto>>('/api/v1/solution-settings')),

  update: (req: UpdateSolutionSettingsRequest) =>
    unwrap(api.patch<ApiResponse<SolutionSettingsDto>>('/api/v1/solution-settings', req)),
};
