import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PreflightCheckResult, CheckStatus } from '../lib/preflightValidation';

export type PreflightPhase = 'idle' | 'checking' | 'done';

/** Re-exported so callers don't have to import from two places. */
export type { CheckStatus };
export type PreflightCheck = PreflightCheckResult;

/** Cached preflight result for one (project, snapshot) pair. */
export interface PreflightSnapshotResult {
  runAt: number;
  selectedTables: string[];
  results: PreflightCheck[];
}

interface PreflightEntry {
  selectedTables: string[];
  /** running animation 用. results 자체는 bySnapshot[currentPinId] 에 저장. */
  preflightPhase: PreflightPhase;
  /** selection 이 변경됐을 때 옛 done 결과를 재검증 필요로 표시. */
  isStale: boolean;
  /** snapshot id → cached preflight result. Execution / Versions 両画面の唯一の真実. */
  bySnapshot: Record<string, PreflightSnapshotResult>;
  /** 마지막으로 표시 중이던 run id. 새로고침 시 pipeline 복원용.
   *  Discard 시 null. 새 run start 시 갱신. undefined = legacy(persist v6) 진입. */
  activeRunId?: string | null;
}

const EMPTY_ENTRY: PreflightEntry = Object.freeze({
  selectedTables: [],
  preflightPhase: 'idle',
  isStale: false,
  bySnapshot: {},
  activeRunId: null,
}) as PreflightEntry;

interface ExecutionPreflightState {
  byProject: Record<string, PreflightEntry>;

  getEntry: (projectId: string | null | undefined) => PreflightEntry;
  setSelected: (projectId: string, tables: string[]) => void;
  setPhase: (projectId: string, phase: PreflightPhase) => void;
  resetForProject: (projectId: string) => void;

  /** Versions 화면 / Execution 화면 공통 cache. snapshotId 별로 결과 보존. */
  setSnapshotResult: (projectId: string, snapshotId: string, result: PreflightSnapshotResult) => void;
  /** 진행 중인 preflight 의 결과 1 件을 bySnapshot[snapshotId].results 끝에 추가. */
  appendSnapshotResultCheck: (projectId: string, snapshotId: string, check: PreflightCheck) => void;
  clearSnapshotResult: (projectId: string, snapshotId: string) => void;

  /** 새로고침 시 pipeline 복원용 — start 시 setActiveRunId(runId), discard 시 null. */
  setActiveRunId: (projectId: string, runId: string | null) => void;
}

/**
 * Pre-flight 워크플로 영속화 store.
 *
 * - 페이지 새로고침 후에도 selectedTables / phase / results 그대로 복원.
 * - project 별로 격리 — 다른 project 로 전환 시 빈 entry 가 반환되므로 자동 reset 효과.
 * - Set 은 JSON 직렬화가 까다로워 array 로 저장. ExecutionPage 가 사용 시점에 Set 으로 변환.
 */
export const useExecutionPreflightStore = create<ExecutionPreflightState>()(
  persist(
    (set, get) => ({
      byProject: {},

      getEntry: (projectId) => {
        if (!projectId) return EMPTY_ENTRY;
        return get().byProject[projectId] ?? EMPTY_ENTRY;
      },

      setSelected: (projectId, tables) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          /* selection 변경 → 직전 done 결과가 stale 化. checking 중엔 마킹하지 않음. */
          const isStale = prev.preflightPhase === 'done';
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...prev, selectedTables: [...tables], isStale },
            },
          };
        });
      },

      setPhase: (projectId, phase) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          /* checking 으로 진입 시 stale flag 해제 (지금 다시 도는 중이므로). */
          const isStale = phase === 'checking' ? false : prev.isStale;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...prev, preflightPhase: phase, isStale },
            },
          };
        });
      },

      resetForProject: (projectId) => {
        set((s) => {
          const prev = s.byProject[projectId];
          if (!prev) return s;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...prev, preflightPhase: 'idle', isStale: false, bySnapshot: {} },
            },
          };
        });
      },

      setSnapshotResult: (projectId, snapshotId, result) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...prev, bySnapshot: { ...prev.bySnapshot, [snapshotId]: result } },
            },
          };
        });
      },

      appendSnapshotResultCheck: (projectId, snapshotId, check) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          const base = prev.bySnapshot[snapshotId];
          if (!base) {
            /* defensive: setSnapshotResult 가 먼저 호출되지 않았을 때 빈 base 채워서 append. */
            return {
              byProject: {
                ...s.byProject,
                [projectId]: {
                  ...prev,
                  bySnapshot: {
                    ...prev.bySnapshot,
                    [snapshotId]: {
                      runAt: Date.now(),
                      selectedTables: prev.selectedTables,
                      results: [check],
                    },
                  },
                },
              },
            };
          }
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...prev,
                bySnapshot: {
                  ...prev.bySnapshot,
                  [snapshotId]: { ...base, results: [...base.results, check] },
                },
              },
            },
          };
        });
      },

      clearSnapshotResult: (projectId, snapshotId) => {
        set((s) => {
          const prev = s.byProject[projectId];
          if (!prev) return s;
          const { [snapshotId]: _drop, ...rest } = prev.bySnapshot;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...prev, bySnapshot: rest },
            },
          };
        });
      },

      setActiveRunId: (projectId, runId) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          if (prev.activeRunId === runId) return s;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...prev, activeRunId: runId },
            },
          };
        });
      },
    }),
    {
      name: 'mpd:exec-preflight',
      // v0 → v1 (2026-05-24): approved-snapshot 체크 항목 제거.
      // v1 → v2 (2026-05-25): runId 형식 변경.
      // v2 → v3 (2026-05-25): ActiveRunState 에 haltedAt 추가.
      // v3 → v4 (2026-05-26): PreflightCheck 가 per-table 化, selectedSnapshotId 撤去.
      // v4 → v5 (2026-05-26): preflightResults 撤去 — bySnapshot[snapshotId] が唯一의 真実.
      // v5 → v6 (2026-05-28): mock simulation 用 activeRun + runCounter 撤去 (BE 폴링이 진실).
      version: 6,
      migrate: (persistedState: unknown, _version: number) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState;
        const state = persistedState as { byProject?: Record<string, Partial<PreflightEntry> & { activeRun?: unknown; runCounter?: unknown; selectedSnapshotId?: unknown; preflightResults?: unknown }> };
        if (!state.byProject) return persistedState;
        const fixed: Record<string, PreflightEntry> = {};
        for (const id in state.byProject) {
          const entry = state.byProject[id];
          /* activeRun, runCounter, selectedSnapshotId, preflightResults 모두 drop. */
          fixed[id] = {
            selectedTables: entry.selectedTables ?? [],
            preflightPhase: 'idle',
            isStale: false,
            bySnapshot: entry.bySnapshot ?? {},
          };
        }
        return { ...state, byProject: fixed };
      },
    },
  ),
);
