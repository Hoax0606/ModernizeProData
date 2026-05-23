import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PreflightPhase = 'idle' | 'checking' | 'done';
export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface PreflightCheck {
  id: string;
  title: string;
  detail: string;
  status: CheckStatus;
  affectedTables?: string[];
}

interface PreflightEntry {
  selectedTables: string[];
  preflightPhase: PreflightPhase;
  preflightResults: PreflightCheck[];
}

const EMPTY_ENTRY: PreflightEntry = Object.freeze({
  selectedTables: [],
  preflightPhase: 'idle',
  preflightResults: [],
}) as PreflightEntry;

interface ExecutionPreflightState {
  byProject: Record<string, PreflightEntry>;

  getEntry: (projectId: string | null | undefined) => PreflightEntry;
  setSelected: (projectId: string, tables: string[]) => void;
  setPhase: (projectId: string, phase: PreflightPhase) => void;
  setResults: (projectId: string, results: PreflightCheck[] | ((prev: PreflightCheck[]) => PreflightCheck[])) => void;
  resetForProject: (projectId: string) => void;
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
        set((s) => ({
          byProject: {
            ...s.byProject,
            [projectId]: {
              ...(s.byProject[projectId] ?? EMPTY_ENTRY),
              selectedTables: tables,
            },
          },
        }));
      },

      setPhase: (projectId, phase) => {
        set((s) => ({
          byProject: {
            ...s.byProject,
            [projectId]: {
              ...(s.byProject[projectId] ?? EMPTY_ENTRY),
              preflightPhase: phase,
            },
          },
        }));
      },

      setResults: (projectId, results) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          const next = typeof results === 'function' ? results(prev.preflightResults) : results;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...prev, preflightResults: next },
            },
          };
        });
      },

      resetForProject: (projectId) => {
        set((s) => {
          const { [projectId]: _drop, ...rest } = s.byProject;
          return { byProject: rest };
        });
      },
    }),
    { name: 'mpd:exec-preflight' },
  ),
);
