import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PreflightCheckResult, CheckStatus } from '../lib/preflightValidation';

export type PreflightPhase = 'idle' | 'checking' | 'done';
export type ActiveRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** Re-exported so callers don't have to import from two places. */
export type { CheckStatus };
export type PreflightCheck = PreflightCheckResult;

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
  /* failed / aborted 로 멈춘 시각 (epoch ms). running / paused / completed 면 null.
     computeElapsedMs 가 이 값을 ref 로 써서 정지 후 progress 가 계속 자라는 버그 방지. */
  haltedAt: number | null;
}

/** Cached preflight result for one (project, snapshot) pair. */
export interface PreflightSnapshotResult {
  runAt: number;
  selectedTables: string[];
  results: PreflightCheck[];
}

interface PreflightEntry {
  selectedTables: string[];
  /** running animation 用. results 自体は bySnapshot[currentPinId] に保存される. */
  preflightPhase: PreflightPhase;
  /* selection 이 변경됐을 때 옛 done 결과를 재검증 필요로 표시. */
  isStale: boolean;
  /* Project 별 누적 run count. Discard → Start over 마다 +1. Retry 는 같은 run 이라 증가 X. */
  runCounter: number;
  activeRun: ActiveRunState | null;
  /** snapshot id → cached preflight result. Execution / Versions 両画面の唯一の真実. */
  bySnapshot: Record<string, PreflightSnapshotResult>;
}

const EMPTY_ENTRY: PreflightEntry = Object.freeze({
  selectedTables: [],
  preflightPhase: 'idle',
  isStale: false,
  runCounter: 0,
  activeRun: null,
  bySnapshot: {},
}) as PreflightEntry;

/** activeRun 생성 시 failure 관련 필드는 모두 null. runId 는 `{projectId} - {runIndex}` 형식. */
function newActiveRun(projectId: string, runIndex: number, selectedTables: string[]): ActiveRunState {
  return {
    runId: `${projectId} - ${runIndex}`,
    selectedTables: [...selectedTables],
    startedAt: Date.now(),
    pausedAt: null,
    pauseAccumMs: 0,
    runStatus: 'running',
    failedStageIndex: null,
    failureReason: null,
    haltedAt: null,
  };
}

interface ExecutionPreflightState {
  byProject: Record<string, PreflightEntry>;

  getEntry: (projectId: string | null | undefined) => PreflightEntry;
  setSelected: (projectId: string, tables: string[]) => void;
  setPhase: (projectId: string, phase: PreflightPhase) => void;
  resetForProject: (projectId: string) => void;

  /** Versions 화면 / Execution 화면 공통 cache. snapshotId 별로 결과 보존. */
  setSnapshotResult: (projectId: string, snapshotId: string, result: PreflightSnapshotResult) => void;
  /** 진행 중인 preflight 의 결과 1 件을 bySnapshot[snapshotId].results 끝に追加. */
  appendSnapshotResultCheck: (projectId: string, snapshotId: string, check: PreflightCheck) => void;
  clearSnapshotResult: (projectId: string, snapshotId: string) => void;

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
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          const wasDone = prev.preflightPhase === 'done';
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...prev,
                selectedTables: tables,
                isStale: wasDone ? true : prev.isStale,
              },
            },
          };
        });
      },

      setPhase: (projectId, phase) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...prev,
                preflightPhase: phase,
                isStale: phase === 'idle' ? false : prev.isStale,
              },
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

      setSnapshotResult: (projectId, snapshotId, result) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...prev,
                isStale: false,
                bySnapshot: { ...prev.bySnapshot, [snapshotId]: result },
              },
            },
          };
        });
      },

      appendSnapshotResultCheck: (projectId, snapshotId, check) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          const existing = prev.bySnapshot[snapshotId];
          /* setSnapshotResult で必ず init される前提だが、念のため defensive. */
          const base: PreflightSnapshotResult = existing ?? {
            runAt: Date.now(),
            selectedTables: prev.selectedTables,
            results: [],
          };
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

      startActiveRun: (projectId, selectedTables) => {
        set((s) => {
          const prev = s.byProject[projectId] ?? EMPTY_ENTRY;
          const nextCount = (prev.runCounter ?? 0) + 1;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...prev,
                runCounter: nextCount,
                activeRun: newActiveRun(projectId, nextCount, selectedTables),
              },
            },
          };
        });
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
          const now = Date.now();
          const pausedFor = entry.activeRun.pausedAt !== null ? now - entry.activeRun.pausedAt : 0;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...entry,
                activeRun: {
                  ...entry.activeRun,
                  runStatus: 'failed',
                  pausedAt: null,
                  pauseAccumMs: entry.activeRun.pauseAccumMs + pausedFor,
                  failedStageIndex: stageIndex,
                  failureReason: reason,
                  haltedAt: now,
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
          if (entry.activeRun.runStatus !== 'running') return s;
          const now = Date.now();
          const pausedFor = entry.activeRun.pausedAt !== null ? now - entry.activeRun.pausedAt : 0;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...entry,
                activeRun: {
                  ...entry.activeRun,
                  runStatus: 'aborted',
                  pausedAt: null,
                  pauseAccumMs: entry.activeRun.pauseAccumMs + pausedFor,
                  failedStageIndex: stageIndex,
                  failureReason: reason,
                  haltedAt: now,
                },
              },
            },
          };
        });
      },

      retryActiveRun: (projectId, stageMs) => {
        set((s) => {
          const entry = s.byProject[projectId];
          if (!entry?.activeRun) return s;
          if (entry.activeRun.runStatus !== 'failed' && entry.activeRun.runStatus !== 'aborted') return s;
          const stageIdx = entry.activeRun.failedStageIndex ?? 0;
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
                  haltedAt: null,
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
      // v0 → v1 (2026-05-24): approved-snapshot 체크 항목 제거.
      // v1 → v2 (2026-05-25): runId 형식 변경 (reh-{timestamp} → {projectId} - {runIndex}).
      // v2 → v3 (2026-05-25): ActiveRunState 에 haltedAt 추가.
      // v3 → v4 (2026-05-26): PreflightCheck 가 per-table 化, selectedSnapshotId 撤去.
      // v4 → v5 (2026-05-26): preflightResults (project 全体の直近 1 回バッファ) 撤去.
      // 結果は bySnapshot[snapshotId] が唯一の真実に. 旧 entry の preflightResults は破棄.
      version: 5,
      migrate: (persistedState: unknown, version: number) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState;
        const state = persistedState as { byProject?: Record<string, PreflightEntry & { selectedSnapshotId?: string | null; preflightResults?: PreflightCheck[] }> };
        if (!state.byProject) return persistedState;
        const fixed: Record<string, PreflightEntry> = {};
        for (const id in state.byProject) {
          const entry = state.byProject[id];
          let activeRun = entry.activeRun;
          if (version < 2 && activeRun?.runId?.startsWith('reh-')) {
            activeRun = null;
          }
          if (version < 3 && activeRun && (activeRun as Partial<ActiveRunState>).haltedAt === undefined) {
            activeRun = { ...activeRun, haltedAt: null };
          }
          const baseRunCounter = version < 2 && entry.activeRun?.runId?.startsWith('reh-') ? 0 : entry.runCounter;
          /* v4 以下からの移行: bySnapshot / 一新. preflightResults は破棄 (ユーザ가 다시 run). */
          fixed[id] = {
            selectedTables: entry.selectedTables ?? [],
            preflightPhase: 'idle',
            isStale: false,
            runCounter: baseRunCounter ?? 0,
            activeRun,
            bySnapshot: entry.bySnapshot ?? {},
          };
        }
        return { ...state, byProject: fixed };
      },
    },
  ),
);
