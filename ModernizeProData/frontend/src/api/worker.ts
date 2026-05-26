import { api, unwrap, type ApiResponse } from './client';

export type WorkerStatus = 'PROVISIONED' | 'REGISTERED' | 'REVOKED';

export interface WorkerSummaryDto {
  workerId: string;
  name: string;
  siteId: string | null;
  userId: string | null;
  status: WorkerStatus;
  registeredAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  createdBy: string;
}

export const workerApi = {
  /** master 한정 — 등록된 worker_node 전체 */
  list: () =>
    unwrap(api.get<ApiResponse<WorkerSummaryDto[]>>('/api/v1/workers')),

  /** master 한정 — worker_node 행 폐기 (admin user 계정은 유지) */
  revoke: (workerId: string) =>
    unwrap(api.delete<ApiResponse<void>>(`/api/v1/workers/${workerId}`)),
};
