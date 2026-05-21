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
};
