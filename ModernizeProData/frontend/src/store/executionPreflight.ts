import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PreflightPhase = 'idle' | 'checking' | 'done';
export type CheckStatus = 'pass' | 'fail' | 'skip';
export type ActiveRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface PreflightCheck {
  id: string;
  title: string;
  detail: string;
  status: CheckStatus;
  affectedTables?: string[];
}

/**
 * 시뮬레이션 진행은 startedAt(절대 시각) + pauseAccumMs 만으로 derive.
 * 페이지 새로고침 후에도 Date.now() 비교로 정확한 stage 위치 복원.
 */
export interface ActiveRunState {
  runId: string;
  selectedTables: string[];
  startedAt: number;
  pausedAt: number | null;
  pauseAccumMs: number;
  runStatus: ActiveRunStatus;
  /* Failure 발생 시 어느 stage 에서 / 왜 멈췄는지. running 동안엔 null.
     실제 백엔드 연결 시 fail 이벤트 페이로드가 그대로 매핑된다. */
  failedStageIndex: number | null;
  failureReason: string | null;
}

interface PreflightEntry {
  selectedTables: string[];
  selectedSnapshotId: string | null;
  preflightPhase: PreflightPhase;
  preflightResults: PreflightCheck[];
  activeRun: ActiveRunState | null;
}

const EMPTY_ENTRY: PreflightEntry = Object.freeze({
  selectedTables: [],
  selectedSnapshotId: null,
  preflightPhase: 'idle',
  preflightResults: [],
  activeRun: null,
}) as PreflightEntry;

/** activeRun 생성 시 failure 관련 필드는 모두 null. */
function newActiveRun(selectedTables: string[]): ActiveRunState {
  return {
    runId: `reh-${Date.now()}`,
    selectedTables: [...selectedTables],
    startedAt: Date.now(),
    pausedAt: null,
    pauseAccumMs: 0,
    runStatus: 'running',
    failedStageIndex: null,
    failureReason: null,
  };
}

interface ExecutionPreflightState {
  byProject: Record<string, PreflightEntry>;

  getEntry: (projectId: string | null | undefined) => PreflightEntry;
  setSelected: (projectId: string, tables: string[]) => void;
  setSelectedSnapshot: (projectId: string, snapshotId: string | null) => void;
  setPhase: (projectId: string, phase: PreflightPhase) => void;
  setResults: (projectId: string, results: PreflightCheck[] | ((prev: PreflightCheck[]) => PreflightCheck[])) => void;
  resetForProject: (projectId: string) => void;

  /* Active run (frontend mock simulation) — 백엔드 run engine 미연결 시점의 시각 흐름 데모. */
  startActiveRun: (projectId: string, selectedTables: string[]) => void;
  pauseActiveRun: (projectId: string) => void;
  resumeActiveRun: (projectId: string) => void;
  finishActiveRun: (projectId: string) => void;
  failActiveRun: (projectId: string, stageIndex: number, reason: string) => void;
  /** 사용자 명시 중단 — 동작은 fail 과 동일 (멈춘 stage / reason 기록), runStatus 만 'aborted'. */
  abortActiveRun: (projectId: string, stageIndex: number, reason: string) => void;
  /** failed → running. 실패 stage 부터 다시 진행하도록 startedAt 을 거꾸로 맞춤. */
  retryActiveRun: (projectId: string, stageMs: number) => void;
  clearActiveRun: (projectId: string) => void;
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

      setSelectedSnapshot: (projectId, snapshotId) => {
        set((s) => ({
          byProject: {
            ...s.byProject,
            [projectId]: {
              ...(s.byProject[projectId] ?? EMPTY_ENTRY),
              selectedSnapshotId: snapshotId,
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

      startActiveRun: (projectId, selectedTables) => {
        set((s) => ({
          byProject: {
            ...s.byProject,
            [projectId]: {
              ...(s.byProject[projectId] ?? EMPTY_ENTRY),
              activeRun: newActiveRun(selectedTables),
            },
          },
        }));
      },

      pauseActiveRun: (projectId) => {
        set((s) => {
          const entry = s.byProject[projectId];
          if (!entry?.activeRun || entry.activeRun.pausedAt !== null) return s;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...entry,
                activeRun: { ...entry.activeRun, pausedAt: Date.now() },
              },
            },
          };
        });
      },

      resumeActiveRun: (projectId) => {
        set((s) => {
          const entry = s.byProject[projectId];
          if (!entry?.activeRun || entry.activeRun.pausedAt === null) return s;
          const pausedFor = Date.now() - entry.activeRun.pausedAt;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...entry,
                activeRun: {
                  ...entry.activeRun,
                  pausedAt: null,
                  pauseAccumMs: entry.activeRun.pauseAccumMs + pausedFor,
                },
              },
            },
          };
        });
      },

      finishActiveRun: (projectId) => {
        set((s) => {
          const entry = s.byProject[projectId];
          if (!entry?.activeRun || entry.activeRun.runStatus === 'completed') return s;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...entry,
                activeRun: { ...entry.activeRun, runStatus: 'completed', pausedAt: null },
              },
            },
          };
        });
      },

      failActiveRun: (projectId, stageIndex, reason) => {
        set((s) => {
          const entry = s.byProject[projectId];
          if (!entry?.activeRun || entry.activeRun.runStatus !== 'running') return s;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...entry,
                activeRun: {
                  ...entry.activeRun,
                  runStatus: 'failed',
                  pausedAt: null,
                  failedStageIndex: stageIndex,
                  failureReason: reason,
                },
              },
            },
          };
        });
      },

      abortActiveRun: (projectId, stageIndex, reason) => {
        set((s) => {
          const entry = s.byProject[projectId];
          if (!entry?.activeRun) return s;
          /* running / paused 모두에서 호출 가능. completed / failed / aborted 면 무시. */
          if (entry.activeRun.runStatus !== 'running') return s;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...entry,
                activeRun: {
                  ...entry.activeRun,
                  runStatus: 'aborted',
                  pausedAt: null,
                  failedStageIndex: stageIndex,
                  failureReason: reason,
                },
              },
            },
          };
        });
      },

      retryActiveRun: (projectId, stageMs) => {
        set((s) => {
          const entry = s.byProject[projectId];
          /* failed / aborted 둘 다에서 호출 가능 — 멈춘 stage 부터 resume. */
          if (!entry?.activeRun) return s;
          if (entry.activeRun.runStatus !== 'failed' && entry.activeRun.runStatus !== 'aborted') return s;
          const stageIdx = entry.activeRun.failedStageIndex ?? 0;
          /* 실패 stage 부터 simulation 재시작: 이미 끝난 stage 는 즉시 ok 표시되도록
             startedAt 을 stageIdx * stageMs 만큼 과거로. pauseAccum 은 0 으로 reset. */
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...entry,
                activeRun: {
                  ...entry.activeRun,
                  startedAt: Date.now() - stageIdx * stageMs,
                  pausedAt: null,
                  pauseAccumMs: 0,
                  runStatus: 'running',
                  failedStageIndex: null,
                  failureReason: null,
                },
              },
            },
          };
        });
      },

      clearActiveRun: (projectId) => {
        set((s) => {
          const entry = s.byProject[projectId];
          if (!entry?.activeRun) return s;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...entry, activeRun: null },
            },
          };
        });
      },
    }),
    {
      name: 'mpd:exec-preflight',
      // v0 → v1 (2026-05-24): approved-snapshot 체크 항목 제거. 옛 캐시 (8개 체크 결과 포함)
      // 와 신 schema (7개) 가 호환 안 돼서 그냥 invalidate — 사용자가 Pre-flight 다시 한 번 돌리면 회복.
      version: 1,
    },
  ),
);
