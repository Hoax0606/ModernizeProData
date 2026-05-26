import { api, unwrap, type ApiResponse } from './client';
import type { Site, Project } from '../store/workspace';
import type { MappingSnapshot, SnapshotData } from '../store/snapshots';

/* ── Site API ─────────────────────────────────────── */

export const siteApi = {
  list: () =>
    unwrap(api.get<ApiResponse<Site[]>>('/api/v1/sites')),

  get: (id: string) =>
    unwrap(api.get<ApiResponse<Site>>(`/api/v1/sites/${id}`)),

  create: (data: Omit<Site, 'id' | 'createdAt' | 'createdBy'>) =>
    unwrap(api.post<ApiResponse<Site>>('/api/v1/sites', data)),

  update: (id: string, patch: Partial<Site>) =>
    unwrap(api.patch<ApiResponse<Site>>(`/api/v1/sites/${id}`, patch)),

  delete: (id: string) =>
    unwrap(api.delete<ApiResponse<void>>(`/api/v1/sites/${id}`)),
};

/* ── Project API ──────────────────────────────────── */

export const projectApi = {
  listBySite: (siteId: string) =>
    unwrap(api.get<ApiResponse<Project[]>>(`/api/v1/sites/${siteId}/projects`)),

  get: (id: string) =>
    unwrap(api.get<ApiResponse<Project>>(`/api/v1/projects/${id}`)),

  create: (siteId: string, data: { name: string; phase?: string; tableCount?: number; ddlFiles?: unknown[]; assignee?: string }) =>
    unwrap(api.post<ApiResponse<Project>>(`/api/v1/sites/${siteId}/projects`, data)),

  update: (id: string, patch: Partial<Project>) =>
    unwrap(api.patch<ApiResponse<Project>>(`/api/v1/projects/${id}`, patch)),

  delete: (id: string) =>
    unwrap(api.delete<ApiResponse<void>>(`/api/v1/projects/${id}`)),
};

/* ── Snapshot API ─────────────────────────────────── */

export const snapshotApi = {
  listByProject: (projectId: string) =>
    unwrap(api.get<ApiResponse<MappingSnapshot[]>>(`/api/v1/projects/${projectId}/snapshots`)),

  listBySite: (siteId: string) =>
    unwrap(api.get<ApiResponse<MappingSnapshot[]>>(`/api/v1/sites/${siteId}/snapshots`)),

  create: (projectId: string, data: { name: string; description?: string; type?: string }) =>
    unwrap(api.post<ApiResponse<MappingSnapshot>>(`/api/v1/projects/${projectId}/snapshots`, data)),

  request: (id: string) =>
    unwrap(api.post<ApiResponse<MappingSnapshot>>(`/api/v1/snapshots/${id}/request`)),

  approve: (id: string) =>
    unwrap(api.post<ApiResponse<MappingSnapshot>>(`/api/v1/snapshots/${id}/approve`)),

  reject: (id: string, reason: string) =>
    unwrap(api.post<ApiResponse<MappingSnapshot>>(`/api/v1/snapshots/${id}/reject`, { reason })),

  delete: (id: string) =>
    unwrap(api.delete<ApiResponse<void>>(`/api/v1/snapshots/${id}`)),

  /** snapshot 생성 시점에 동결된 mapping payload (rules + codeMaps + bindings). */
  getMapping: (id: string) =>
    unwrap(api.get<ApiResponse<SnapshotData>>(`/api/v1/snapshots/${id}/mapping`)),

  /** 이 snapshot 을 project 의 고정핀(baseline)으로 설정 — 기존 baseline 은 자동 해제. */
  setBaseline: (id: string) =>
    unwrap(api.post<ApiResponse<MappingSnapshot>>(`/api/v1/snapshots/${id}/baseline`)),

  /** 고정핀 해제. */
  clearBaseline: (id: string) =>
    unwrap(api.delete<ApiResponse<MappingSnapshot>>(`/api/v1/snapshots/${id}/baseline`)),
};
