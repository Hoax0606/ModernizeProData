import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { snapshotApi } from '../api/workspace';

export type SnapshotStatus = 'draft' | 'pending' | 'approved' | 'rejected';
export type SnapshotType = 'mapping' | 'cutover';

export interface MappingSnapshot {
  id: string;
  projectId: string;
  name: string;
  version: string;
  description?: string;
  type: SnapshotType;
  status: SnapshotStatus;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  tableCount: number;
  ruleCount: number;
}

interface SnapshotsState {
  snapshots: MappingSnapshot[];

  fetchByProject: (projectId: string) => Promise<void>;
  fetchBySite: (siteId: string) => Promise<void>;
  createSnapshot: (projectId: string, data: { name: string; description?: string; type?: string; tableCount: number; ruleCount: number }) => Promise<MappingSnapshot>;
  requestSnapshot: (id: string) => Promise<void>;
  approveSnapshot: (id: string) => Promise<void>;
  rejectSnapshot: (id: string, reason: string) => Promise<void>;
  deleteSnapshot: (id: string) => Promise<void>;
}

/**
 * 매핑 스냅샷 store — 백엔드 API 연동.
 * 모든 팀원이 동일 데이터를 공유.
 */
export const useSnapshotsStore = create<SnapshotsState>()(
  (set, get) => ({
    snapshots: [],

    fetchByProject: async (projectId) => {
      try {
        const list = await snapshotApi.listByProject(projectId);
        set((st) => ({
          snapshots: [
            ...st.snapshots.filter((s) => s.projectId !== projectId),
            ...list,
          ],
        }));
      } catch { /* polling에서 재시도 */ }
    },

    fetchBySite: async (siteId) => {
      try {
        const list = await snapshotApi.listBySite(siteId);
        // 사이트 내 모든 프로젝트의 스냅샷 교체
        const projectIds = new Set(list.map((s) => s.projectId));
        set((st) => ({
          snapshots: [
            ...st.snapshots.filter((s) => !projectIds.has(s.projectId)),
            ...list,
          ],
        }));
      } catch { /* polling에서 재시도 */ }
    },

    createSnapshot: async (projectId, data) => {
      const s = await snapshotApi.create(projectId, data);
      set((st) => ({ snapshots: [...st.snapshots, s] }));
      return s;
    },

    requestSnapshot: async (id) => {
      const updated = await snapshotApi.request(id);
      set((st) => ({
        snapshots: st.snapshots.map((s) => s.id === id ? updated : s),
      }));
    },

    approveSnapshot: async (id) => {
      const updated = await snapshotApi.approve(id);
      set((st) => ({
        snapshots: st.snapshots.map((s) => s.id === id ? updated : s),
      }));
    },

    rejectSnapshot: async (id, reason) => {
      const updated = await snapshotApi.reject(id, reason);
      set((st) => ({
        snapshots: st.snapshots.map((s) => s.id === id ? updated : s),
      }));
    },

    deleteSnapshot: async (id) => {
      await snapshotApi.delete(id);
      set((st) => ({
        snapshots: st.snapshots.filter((s) => s.id !== id),
      }));
    },
  }),
);

/**
 * Versions 화면에서 사용자가 상단에 고정한 snapshot id 집합.
 * UI-only — 백엔드 비저장. localStorage 영속.
 */
interface PinnedSnapshotsState {
  pinnedIds: string[];
  togglePin: (id: string) => void;
  setPin: (id: string) => void;
  clearPin: () => void;
  isPinned: (id: string) => boolean;
}

export const usePinnedSnapshotsStore = create<PinnedSnapshotsState>()(
  persist(
    (set, get) => ({
      pinnedIds: [],
      // 한 번에 단 한 개의 snapshot 만 고정 가능 — 새로 고정 시 기존 고정 해제.
      togglePin: (id) =>
        set((st) => ({
          pinnedIds: st.pinnedIds.includes(id) ? [] : [id],
        })),
      // approve 직후 자동 pin — 기존 pin 은 교체됨.
      setPin: (id) => set({ pinnedIds: [id] }),
      clearPin: () => set({ pinnedIds: [] }),
      isPinned: (id) => get().pinnedIds.includes(id),
    }),
    { name: 'modernize-pinned-snapshots' },
  ),
);

/**
 * Phase 별 pin 가능 규칙.
 *  - planning / analysis / test       : approved 아닌 mapping snapshot
 *  - sign-off / rehearsal             : approved mapping snapshot
 *  - ready / cutover / hypercare / done: approved cutover snapshot
 */
export function isPinEligible(
  snapshot: Pick<MappingSnapshot, 'type' | 'status'>,
  phase: string,
): boolean {
  const type = snapshot.type ?? 'mapping';
  const isApproved = snapshot.status === 'approved';

  if (['planning', 'analysis', 'test'].includes(phase)) {
    return type === 'mapping' && !isApproved;
  }
  if (['sign-off', 'rehearsal'].includes(phase)) {
    return type === 'mapping' && isApproved;
  }
  if (['ready', 'cutover', 'hypercare', 'done'].includes(phase)) {
    return type === 'cutover' && isApproved;
  }
  return false;
}
