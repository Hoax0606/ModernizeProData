import { api, unwrap, type ApiResponse } from './client';

export interface UpdateStatusDto {
  currentVersion: string | null;
  latestVersion: string | null;
  lastCheckAt: string | null;
  lastCheckStatus: 'not-yet' | 'success' | 'failed';
  lastCheckError: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
}

export interface ApplyResultDto {
  success: boolean;
  message: string;
}

export const updatesApi = {
  /** 현재 cached 상태. 호출 자체로 fetch 발생 X. */
  status: () =>
    unwrap(api.get<ApiResponse<UpdateStatusDto>>('/api/v1/updates/status')),

  /** Manifest URL 에서 latest 적극 fetch + cache 갱신. silent fail. */
  check: () =>
    unwrap(api.post<ApiResponse<UpdateStatusDto>>('/api/v1/updates/check')),

  /** Delta zip download + sha256 + 서명 검증 + staging 풀기. 실 swap 은 다음 부팅. */
  apply: () =>
    unwrap(api.post<ApiResponse<ApplyResultDto>>('/api/v1/updates/apply')),
};
