import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuditLogEntry {
  id: string;
  projectId: string;
  timestamp: string;
  user: string;
  action: string;
  description: string;
  snapshotName?: string;
  snapshotId?: string;
  snapshotType?: 'mapping' | 'cutover';
}

interface AuditLogState {
  logs: AuditLogEntry[];

  add: (entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) => void;
  getByProject: (projectId: string) => AuditLogEntry[];
  clearByProject: (projectId: string) => void;
}

/**
 * Audit log — 프로젝트 단위로 누적. localStorage 영속.
 * (서버 audit_log 테이블이 들어오면 그쪽으로 교체)
 */
export const useAuditLogStore = create<AuditLogState>()(
  persist(
    (set, get) => ({
      logs: [],

      add: (entry) => {
        const newLog: AuditLogEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          ...entry,
        };
        set((st) => ({ logs: [newLog, ...st.logs] }));
      },

      getByProject: (projectId) =>
        get().logs.filter((l) => l.projectId === projectId),

      clearByProject: (projectId) =>
        set((st) => ({ logs: st.logs.filter((l) => l.projectId !== projectId) })),
    }),
    { name: 'modernize-audit-log' },
  ),
);
