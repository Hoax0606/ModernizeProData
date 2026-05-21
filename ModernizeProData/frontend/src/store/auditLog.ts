import { create } from 'zustand';
import { auditLogApi, type ApiAuditLogEntry } from '../api/auditLog';

export interface AuditLogEntry {
  id: string;
  siteId: string;
  projectId: string;
  timestamp: string;
  user: string;
  action: string;
  description: string;
  snapshotName?: string;
  snapshotId?: string;
}

function mapEntry(api: ApiAuditLogEntry): AuditLogEntry {
  return {
    id: api.id,
    siteId: api.siteId,
    projectId: api.projectId ?? '',
    timestamp: api.timestamp,
    user: api.username,
    action: api.action,
    description: api.details ?? '',
    snapshotName: api.snapshotName ?? undefined,
    snapshotId: api.snapshotId ?? undefined,
  };
}

interface AuditLogState {
  logs: AuditLogEntry[];
  fetchBySite: (siteId: string) => Promise<void>;
  fetchByProject: (projectId: string) => Promise<void>;
  getByProject: (projectId: string) => AuditLogEntry[];

  // ── Legacy no-op shims (호환용) ───────────────────
  // backend 가 controller 에서 audit 를 자동 기록하므로 frontend 의 add/clear 호출은
  // 더 이상 필요 없음. 기존 호출처는 한 번에 모두 제거하지 않고, 여기서 no-op 처리.
  add: (entry: Omit<AuditLogEntry, 'id' | 'timestamp' | 'siteId'>) => void;
  clearByProject: (projectId: string) => void;
}

/**
 * Audit log — backend (audit_log 테이블) 가 source of truth.
 * AppShell polling 으로 fetchBySite 호출 → 모든 계정이 동일한 데이터 조회.
 */
export const useAuditLogStore = create<AuditLogState>()((set, get) => ({
  logs: [],

  fetchBySite: async (siteId) => {
    try {
      const data = await auditLogApi.listBySite(siteId);
      set({ logs: data.map(mapEntry) });
    } catch (e) {
      console.error('[auditLog] fetchBySite failed', e);
    }
  },

  fetchByProject: async (projectId) => {
    try {
      const data = await auditLogApi.listByProject(projectId);
      // project 단위는 site 전체를 덮어쓰지 않고 부분 merge (site fetch 결과는 그대로 유지)
      set((st) => {
        const remaining = st.logs.filter((l) => l.projectId !== projectId);
        const incoming = data.map(mapEntry);
        return { logs: [...remaining, ...incoming].sort((a, b) => b.timestamp.localeCompare(a.timestamp)) };
      });
    } catch (e) {
      console.error('[auditLog] fetchByProject failed', e);
    }
  },

  getByProject: (projectId) => get().logs.filter((l) => l.projectId === projectId),

  // Legacy no-ops — backend 가 처리하므로 무시. 기존 호출처에서 제거 권장.
  add: () => {},
  clearByProject: () => {},
}));
