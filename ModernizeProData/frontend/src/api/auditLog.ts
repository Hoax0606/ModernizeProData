import { api, unwrap, type ApiResponse } from './client';

export interface ApiAuditLogEntry {
  id: string;
  siteId: string;
  projectId: string | null;
  username: string;
  action: string;
  target: string | null;
  details: string | null;
  snapshotId: string | null;
  snapshotName: string | null;
  timestamp: string;
}

export const auditLogApi = {
  listBySite: (siteId: string) =>
    unwrap(api.get<ApiResponse<ApiAuditLogEntry[]>>(`/api/v1/sites/${siteId}/audit-logs`)),

  listByProject: (projectId: string) =>
    unwrap(api.get<ApiResponse<ApiAuditLogEntry[]>>(`/api/v1/projects/${projectId}/audit-logs`)),
};
