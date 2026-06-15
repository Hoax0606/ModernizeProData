import { api, unwrap, type ApiResponse } from './client';

export interface TestConnectionRequest {
  dbType: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  sqlState?: string | null;
}

/** 환경별 TO-BE DB 실시간 도달성 (GET .../tobe-db/health). */
export interface EnvHealth {
  env: string;
  /** 설정(type/host/database/username)이 충분한지. */
  configured: boolean;
  /** 실제 JDBC 연결 성공 여부. */
  reachable: boolean;
  message: string;
  checkedAt: string | null;
}

/** env → EnvHealth (test/dev/staging/production). */
export type TobeDbHealth = Record<string, EnvHealth>;

export const tobeDbApi = {
  testConnection: (siteId: string, req: TestConnectionRequest) =>
    unwrap(
      api.post<ApiResponse<TestConnectionResult>>(
        `/api/v1/sites/${siteId}/tobe-db/test-connection`,
        req,
      ),
    ),

  /** 사이트 생성 모달 등 site id 가 아직 없을 때 사용. */
  testConnectionStandalone: (req: TestConnectionRequest) =>
    unwrap(
      api.post<ApiResponse<TestConnectionResult>>(
        `/api/v1/tobe-db/test-connection`,
        req,
      ),
    ),

  /** 환경별 실시간 도달성 — FE 가 주기적으로 polling (서버측 5s 캐시). */
  health: (siteId: string) =>
    unwrap(api.get<ApiResponse<TobeDbHealth>>(`/api/v1/sites/${siteId}/tobe-db/health`)),
};
