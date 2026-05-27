import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { snapshotApi } from '../api/workspace';

export type SnapshotStatus = 'draft' | 'pending' | 'approved' | 'rejected';
export type SnapshotType = 'mapping' | 'cutover';

/**
 * snapshot 생성 시점에 동결된 mapping payload.
 * 백엔드 SnapshotData (record) 와 1:1 대응. snapshots.snapshot_data (jsonb) 에서 직렬화.
 */
export interface SnapshotData {
  rules: FrozenRule[];
  codeMaps: FrozenCodeMap[];
  bindings: FrozenBinding[];
}

export interface FrozenRule {
  id: string;
  tobeSchema: string;
  tobeTable: string;
  tobeColumn: string;
  asisSchema: string | null;
  asisTable: string | null;
  asisColumn: string[] | null;
  asisType: string[] | null;
  codeDomain: string | null;
  strategy: 'expression' | 'null' | 'default' | 'skip';
  transformRule: string | null;
  transformSql: string | null;
  defaultValue: string | null;
  notNullOverride: boolean;
  ruleOrigin: 'imported' | 'manual';
  notes: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface FrozenCodeMap {
  id: string;
  domain: string;
  sourceValue: string;
  targetValue: string;
  description: string | null;
  ordinal: number;
}

export interface FrozenBinding {
  id: string;
  tobeSchema: string;
  tobeTable: string;
  compositionKind: 'single' | 'join' | 'union' | 'none';
  whereFilter: string | null;
  bindingOrigin: 'imported' | 'manual';
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  sources: FrozenBindingSource[];
}

export interface FrozenBindingSource {
  id: string;
  ordinal: number;
  asisSchema: string | null;
  asisTable: string;
  alias: string;
  role: 'primary' | 'join' | 'union';
  joinType: string | null;
  joinOn: string | null;
}

/**
 * snapshot 생성 시점에 박제된 "이전 버전 대비 변경사항".
 * 백엔드 SnapshotChanges record 와 1:1. snapshots.changes (jsonb) 직렬화.
 */
export interface SnapshotChanges {
  /** 비교 기준이 된 snapshot id. 첫 snapshot 이면 null. */
  previousVersionId: string | null;
  /** 비교 기준이 된 snapshot version (e.g. "v1.2"). */
  previousVersion: string | null;
  summary: { added: number; modified: number; removed: number };
  items: ChangeItem[];
}

export interface ChangeItem {
  kind: 'added' | 'modified' | 'removed';
  category: 'rule' | 'binding' | 'codeMap';
  /** 사람이 읽을 식별자 (e.g. "public.customer.gender"). */
  key: string;
  /** 짧은 설명. */
  detail: string;
  /** modified 일 때만 채워짐. 어느 필드가 어떤 값에서 어떤 값으로 바뀌었는지. */
  fieldChanges?: FieldChange[] | null;
}

/** modified 항목의 필드 단위 변경. before/after 는 문자열로 정규화. */
export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

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
  codeMapCount: number;
  snapshotData?: SnapshotData;
  /**
   * 프로젝트의 현재 고정핀(baseline). 백엔드의 snapshots.is_baseline 과 1:1.
   * 키 이름이 `baseline` 인 이유: Java 의 boolean 필드 `baseline` + Lombok isBaseline()
   * getter 를 Jackson 이 직렬화하면 JSON key 가 "baseline" 으로 나오기 때문.
   */
  baseline?: boolean;
  /** 생성 시점에 박제된 이전 버전 대비 변경 요약 + 항목. */
  changes?: SnapshotChanges;
  /** changes.previousVersionId 와 같은 값을 entity-level 에서도 노출. */
  previousVersionId?: string;
}

interface SnapshotsState {
  snapshots: MappingSnapshot[];

  fetchByProject: (projectId: string) => Promise<void>;
  fetchBySite: (siteId: string) => Promise<void>;
  createSnapshot: (projectId: string, data: { name: string; description?: string; type?: string }) => Promise<MappingSnapshot>;
  requestSnapshot: (id: string) => Promise<void>;
  approveSnapshot: (id: string) => Promise<void>;
  rejectSnapshot: (id: string, reason: string) => Promise<void>;
  deleteSnapshot: (id: string) => Promise<void>;
  /** snapshotData (rules / bindings / codeMaps) を lazy fetch 하고 cache. 既に在ればそのまま返す. */
  ensureSnapshotData: (id: string) => Promise<SnapshotData>;
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
        syncPinnedFromList(list);
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
        syncPinnedFromList(list);
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

    ensureSnapshotData: async (id) => {
      const existing = get().snapshots.find((s) => s.id === id);
      if (existing?.snapshotData) return existing.snapshotData;
      const raw = await snapshotApi.getMapping(id);
      /* BE が空の mapping (rules/bindings/codeMaps が無い snapshot) を返すと null/undefined
         になる場合があるので空配列で正規化. runPreflight が input.snapshotData.bindings 등을
         non-null 으로 가정한다. */
      const data: SnapshotData = raw ?? { rules: [], bindings: [], codeMaps: [] };
      const normalized: SnapshotData = {
        rules: data.rules ?? [],
        bindings: data.bindings ?? [],
        codeMaps: data.codeMaps ?? [],
      };
      set((st) => ({
        snapshots: st.snapshots.map((s) => s.id === id ? { ...s, snapshotData: normalized } : s),
      }));
      return normalized;
    },
  }),
);

/**
 * Versions 화면에서 사용자가 상단에 고정한 snapshot id 집합.
 *
 * 정책: **프로젝트당 1개 핀**. 한 프로젝트에서 새 핀을 set 해도 다른 프로젝트의 핀은 유지.
 * pinnedIds 는 여러 프로젝트의 baseline 들을 동시에 담는다 (프로젝트 수만큼).
 *
 * 백엔드 snapshots.is_baseline 과 동기화. localStorage 는 캐시 역할 (오프라인/초기 paint).
 */
interface PinnedSnapshotsState {
  pinnedIds: string[];
  togglePin: (id: string) => void;
  setPin: (id: string) => void;
  clearPin: (id?: string) => void;
  isPinned: (id: string) => boolean;
}

/** id 로 snapshot 의 projectId 찾기. 없으면 undefined. */
function projectIdOf(id: string): string | undefined {
  return useSnapshotsStore.getState().snapshots.find((s) => s.id === id)?.projectId;
}

export const usePinnedSnapshotsStore = create<PinnedSnapshotsState>()(
  persist(
    (set, get) => ({
      pinnedIds: [],
      // 같은 프로젝트 안에서만 단일 핀 — 새 핀 set 시 그 프로젝트의 기존 핀만 해제.
      //
      // Restore 모델: setBaseline 은 backend 에서 mapping_* 를 snapshot 시점으로 wipe+replace 함.
      // pinnedIds 를 낙관적으로 즉시 갱신하면 MappingPage 의 main hydrate effect 가 setBaseline
      // 완료 전에 listRules 를 호출하여 옛 (v3) 데이터를 가져와 깜빡임이 발생.
      // → set 케이스는 setBaseline 완료 후 pinnedIds 갱신 + snapshots refetch (baseline 필드 sync).
      // → clear 케이스는 mapping_* 가 그대로라 즉시 낙관적 갱신.
      togglePin: (id) => {
        const wasPinned = get().pinnedIds.includes(id);
        const projectId = projectIdOf(id);
        if (wasPinned) {
          set((st) => ({ pinnedIds: st.pinnedIds.filter((pid) => pid !== id) }));
          snapshotApi.clearBaseline(id).catch(() => {});
          return;
        }
        snapshotApi.setBaseline(id).then(() => {
          set((st) => {
            const others = projectId
              ? st.pinnedIds.filter((pid) => projectIdOf(pid) !== projectId)
              : st.pinnedIds.filter((pid) => pid !== id);
            return { pinnedIds: [...others, id] };
          });
          if (projectId) {
            useSnapshotsStore.getState().fetchByProject(projectId).catch(() => {});
          }
        }).catch(() => { /* 실패 시 다음 fetch 가 백엔드 truth 로 정정 */ });
      },
      // approve 직후 자동 pin — 같은 프로젝트의 기존 pin 만 교체됨.
      // togglePin 의 set 케이스와 동일 패턴 (Restore 모델 race 회피).
      setPin: (id) => {
        const projectId = projectIdOf(id);
        snapshotApi.setBaseline(id).then(() => {
          set((st) => {
            const others = projectId
              ? st.pinnedIds.filter((pid) => projectIdOf(pid) !== projectId)
              : st.pinnedIds.filter((pid) => pid !== id);
            return { pinnedIds: [...others, id] };
          });
          if (projectId) {
            useSnapshotsStore.getState().fetchByProject(projectId).catch(() => {});
          }
        }).catch(() => {});
      },
      // 인자 없으면 모든 핀 해제, id 주면 그 핀만 해제.
      clearPin: (id) => {
        if (!id) {
          const all = get().pinnedIds;
          set({ pinnedIds: [] });
          all.forEach((pid) => { snapshotApi.clearBaseline(pid).catch(() => {}); });
          return;
        }
        set((st) => ({ pinnedIds: st.pinnedIds.filter((pid) => pid !== id) }));
        snapshotApi.clearBaseline(id).catch(() => {});
      },
      isPinned: (id) => get().pinnedIds.includes(id),
    }),
    { name: 'modernize-pinned-snapshots' },
  ),
);

/**
 * snapshot list 응답으로부터 pinnedIds 갱신.
 * - 응답 list 에 포함된 snapshot id 들은 응답의 baseline 값을 신뢰 (true 면 유지/추가, false 면 제거).
 * - 응답 list 에 없는 id (= 다른 프로젝트의 핀) 는 그대로 유지.
 */
function syncPinnedFromList(list: MappingSnapshot[]) {
  if (list.length === 0) return;
  const inListIds = new Set(list.map((s) => s.id));
  const newBaselines = list.filter((s) => s.baseline).map((s) => s.id);
  usePinnedSnapshotsStore.setState((st) => ({
    pinnedIds: [
      ...st.pinnedIds.filter((pid) => !inListIds.has(pid)),
      ...newBaselines,
    ],
  }));
}

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
