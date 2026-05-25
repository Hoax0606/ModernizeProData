import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { siteApi, projectApi } from '../api/workspace';

export type ProjectPhase =
  | 'planning'
  | 'analysis'
  | 'test'
  | 'sign-off'
  | 'rehearsal'
  | 'ready'
  | 'cutover'
  | 'hypercare'
  | 'done';

export type RunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted';

export type SiteEnv = 'mainframe' | 'midrange' | 'cloud' | 'on-prem' | 'other';
export type SourceEncoding = 'shift_jis' | 'euc-jp' | 'utf-8' | 'ebcdic';
export type ProjectEnvironment = 'test' | 'dev' | 'staging' | 'production';

export const PROJECT_ENVIRONMENTS: ProjectEnvironment[] = ['dev', 'test', 'staging', 'production'];

export interface SiteDbConnection {
  type: string;     // 'PostgreSQL' | 'Oracle' | ...
  version: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string; // prototype 한정. 실제는 vault 로 교체.
}

export type TobeDbByEnv = Partial<Record<ProjectEnvironment, SiteDbConnection>>;
export type TobeDbLocks = Partial<Record<ProjectEnvironment, boolean>>;

export interface Site {
  id: string;
  name: string;
  asisEnv: SiteEnv;
  tobeEnv: SiteEnv;
  asisEncoding: SourceEncoding;
  tobeEncoding: SourceEncoding;
  /** AS-IS CSV 디렉터리 경로. 도구가 이 경로에서 직접 CSV를 읽어 Parquet 변환. */
  csvPath: string;
  /** AS-IS 측 추출 원본 DB 종류 (Oracle / DB2 / SQL Server / PostgreSQL / MySQL / Mainframe DB2 / Other). 표시용. */
  asisDbType?: string;
  /** AS-IS 측 DB 버전 (예: "11g R2", "16.0"). 표시용. */
  asisDbVersion?: string;
  notes?: string;
  /** 현재 활성 운영 단계 (test/dev/staging/production). TO-BE DB 는 이 단계의 것을 사용. */
  environment: ProjectEnvironment;
  /** 운영 단계별로 따로 저장하는 TO-BE DB 접속 정보. */
  tobeDbByEnv: TobeDbByEnv;
  /**
   * 단계별 lock 상태.
   * - 저장 시 자동 lock.
   * - Worker 는 read-only, Coordinator(master) 만 해제 가능.
   */
  tobeDbLocks: TobeDbLocks;
  createdBy?: string;
  createdAt: string;
}

export interface DdlFile {
  name: string;
  size: number;
  uploadedAt: string;
}

export interface Project {
  id: string;
  siteId: string;
  name: string;
  phase: ProjectPhase;
  /** AS-IS 측 DDL 인포트로 채워지는 테이블 수. */
  tableCount: number;
  /** TO-BE 측 DDL 인포트로 채워지는 테이블 수. */
  tobeTableCount: number;
  ddlFiles: DdlFile[];
  /** 담당자 username — 작성 시 현재 로그인 사용자로 자동 설정. */
  owner: string;
  /** 프로젝트의 개발/매핑 담당. Site Overview 의 dropdown 으로 지정. */
  assignee?: string;
  /** 프로젝트의 실행(run) 담당. Execution Overview 의 dropdown 으로 지정. assignee 와 별개. */
  executionAssignee?: string;
  /** 실행 단계(test/rehearsal/cutover)의 sub-status. phase 전환 시 idle 로 초기화. */
  runStatus?: RunStatus;
  /**
   * 시작 시각 (HH:mm[:ss]). solution_settings.internal_mode="individual" 시만 의미.
   * common mode 에서는 solution_settings.internal_common_time 이 사용됨.
   */
  scheduleStartTime?: string | null;
  /** 마지막 run 실행 시각. Misfire 판정 용. */
  scheduleLastRunAt?: string | null;
  /** Quartz 가 계산한 다음 발화 시각. UI 표시 용 cache (서버가 갱신). */
  scheduleNextRunAt?: string | null;
  createdAt: string;
}

interface WorkspaceState {
  sites: Site[];
  projects: Project[];
  activeSiteId: string | null;
  activeProjectId: string | null;
  loading: boolean;

  /* getters */
  getActiveSite: () => Site | null;
  getActiveProject: () => Project | null;
  getProjectsForActiveSite: () => Project[];

  /* server sync */
  fetchSites: () => Promise<void>;
  fetchProjects: (siteId: string) => Promise<void>;

  /* mutations — all call backend, then update local state */
  createSite: (data: Omit<Site, 'id' | 'createdAt' | 'createdBy'>) => Promise<Site>;
  updateSite: (id: string, patch: Partial<Omit<Site, 'id' | 'createdAt'>>) => Promise<void>;
  createProject: (data: Omit<Project, 'id' | 'siteId' | 'createdAt'>) => Promise<Project>;
  setActiveSite: (id: string | null) => void;
  setActiveProject: (id: string | null) => void;
  deleteProject: (id: string) => Promise<void>;
  deleteSite: (id: string) => Promise<void>;
  addDdlFiles: (projectId: string, files: DdlFile[]) => void;
  removeDdlFile: (projectId: string, fileName: string) => void;

  /** cutover 상태 전환 (Coordinator 전용 — UI 측에서 게이트) */
  startCutover: (projectId: string, snapshotId: string, by: string) => Promise<void>;
  abortCutover: (projectId: string, reason: string, by: string) => Promise<void>;
  finishCutover: (projectId: string, by: string) => Promise<void>;
  /** cutover 담당자 지정 (Coordinator 전용). undefined = 미배정 */
  assignCutover: (projectId: string, assignee: string | undefined) => Promise<void>;
  /** Project 단위 담당자 지정. undefined = 미배정. */
  setProjectAssignee: (projectId: string, assignee: string | undefined) => Promise<void>;
  /** Project 실행 담당자 지정. undefined = 미배정. */
  setProjectExecutionAssignee: (projectId: string, executionAssignee: string | undefined) => Promise<void>;
  /** Project phase 전환 (test/sign-off/... 변경). cutover 흐름과 별개의 일반 전환용. */
  setProjectPhase: (projectId: string, phase: ProjectPhase) => Promise<void>;
  /** Project runStatus 전환 (running/completed/idle). undefined = 초기화. */
  setProjectRunStatus: (projectId: string, runStatus: RunStatus | undefined) => Promise<void>;
}

export const emptyDbConnection = (): SiteDbConnection => ({
  type: '',
  version: '',
  host: '',
  port: '',
  database: '',
  username: '',
  password: '',
});

/**
 * 사이트·프로젝트 관리 store.
 * 백엔드 API 로 CRUD 후 로컬 상태 반영.
 * activeSiteId / activeProjectId 만 localStorage 에 영속.
 */
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      sites: [],
      projects: [],
      activeSiteId: null,
      activeProjectId: null,
      loading: false,

      getActiveSite: () => {
        const { sites, activeSiteId } = get();
        return sites.find((s) => s.id === activeSiteId) ?? null;
      },
      getActiveProject: () => {
        const { projects, activeProjectId } = get();
        return projects.find((p) => p.id === activeProjectId) ?? null;
      },
      getProjectsForActiveSite: () => {
        const { projects, activeSiteId } = get();
        return projects.filter((p) => p.siteId === activeSiteId);
      },

      /* ── Server sync ─────────────────────────────── */

      fetchSites: async () => {
        set({ loading: true });
        try {
          const sites = await siteApi.list();
          const { activeSiteId } = get();
          const stillValid = activeSiteId && sites.some((s) => s.id === activeSiteId);
          set({
            sites,
            activeSiteId: stillValid ? activeSiteId : (sites[0]?.id ?? null),
          });
        } catch (e) {
          console.error('[workspace] fetchSites failed:', e);
        } finally {
          set({ loading: false });
        }
      },

      fetchProjects: async (siteId: string) => {
        try {
          const projects = await projectApi.listBySite(siteId);
          set((s) => ({
            projects: [
              ...s.projects.filter((p) => p.siteId !== siteId),
              ...projects,
            ],
          }));
        } catch (e) {
          console.error('[workspace] fetchProjects failed:', e);
        }
      },

      /* ── Mutations ───────────────────────────────── */

      createSite: async (data) => {
        const site = await siteApi.create(data);
        set((s) => ({ sites: [...s.sites, site], activeSiteId: site.id }));
        return site;
      },

      updateSite: async (id, patch) => {
        const updated = await siteApi.update(id, patch);
        set((s) => ({
          sites: s.sites.map((site) => (site.id === id ? updated : site)),
        }));
      },

      createProject: async (data) => {
        const { activeSiteId } = get();
        if (!activeSiteId) throw new Error('No active site');
        const project = await projectApi.create(activeSiteId, {
          name: data.name,
          phase: data.phase,
          tableCount: data.tableCount,
          ddlFiles: data.ddlFiles,
          assignee: data.assignee,
        });
        set((s) => ({
          projects: [...s.projects, project],
          activeProjectId: project.id,
        }));
        return project;
      },

      setActiveSite: (id) => set({ activeSiteId: id, activeProjectId: null }),
      setActiveProject: (id) => set({ activeProjectId: id }),

      deleteProject: async (id) => {
        await projectApi.delete(id);
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
        }));
      },

      deleteSite: async (id) => {
        await siteApi.delete(id);
        set((s) => {
          const remaining = s.sites.filter((x) => x.id !== id);
          const needSwitch = s.activeSiteId === id;
          return {
            sites: remaining,
            projects: s.projects.filter((p) => p.siteId !== id),
            activeSiteId: needSwitch ? (remaining[0]?.id ?? null) : s.activeSiteId,
            activeProjectId: null,
          };
        });
      },

      addDdlFiles: (projectId, files) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return;
        const existing = project.ddlFiles.filter((f) => !files.some((nf) => nf.name === f.name));
        const updated = [...existing, ...files];
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, ddlFiles: updated } : p
          ),
        }));
        projectApi.update(projectId, { ddlFiles: updated as unknown as DdlFile[] }).catch(() => {});
      },

      removeDdlFile: (projectId, fileName) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return;
        const updated = project.ddlFiles.filter((f) => f.name !== fileName);
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, ddlFiles: updated } : p
          ),
        }));
        projectApi.update(projectId, { ddlFiles: updated as unknown as DdlFile[] }).catch(() => {});
      },

      startCutover: async (projectId, snapshotId, by) => {
        // Cutover 는 production stage 에서만 실행 가능
        const site = get().sites.find((s) => s.id === get().activeSiteId);
        if (site?.environment !== 'production') {
          throw new Error('Cutover can only run in production stage');
        }
        const cutover = {
          snapshotId,
          startedAt: new Date().toISOString(),
          startedBy: by,
        };
        await projectApi.update(projectId, { phase: 'cutover', cutover, runStatus: 'running' });
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, phase: 'cutover' as const, cutover, runStatus: 'running' as const } : p
          ),
        }));
      },

      abortCutover: async (projectId, reason, by) => {
        const project = get().projects.find((p) => p.id === projectId);
        const cutover = {
          ...(project?.cutover ?? {}),
          abortedAt: new Date().toISOString(),
          abortedBy: by,
          abortReason: reason,
        };
        await projectApi.update(projectId, { phase: 'ready', cutover, runStatus: 'idle' });
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, phase: 'ready' as const, cutover, runStatus: 'idle' as const } : p
          ),
        }));
      },

      finishCutover: async (projectId, by) => {
        const project = get().projects.find((p) => p.id === projectId);
        const cutover = {
          ...(project?.cutover ?? {}),
          finishedAt: new Date().toISOString(),
          finishedBy: by,
        };
        await projectApi.update(projectId, { phase: 'hypercare', cutover, runStatus: 'idle' });
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, phase: 'hypercare' as const, cutover, runStatus: undefined } : p
          ),
        }));
      },

      assignCutover: async (projectId, assignee) => {
        const project = get().projects.find((p) => p.id === projectId);
        const cutover = { ...(project?.cutover ?? {}), assignee: assignee || undefined };
        await projectApi.update(projectId, { cutover });
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, cutover } : p
          ),
        }));
      },

      setProjectAssignee: async (projectId, assignee) => {
        // unassigned (undefined) 는 backend 에 빈 문자열로 명시적 clear 요청.
        // 응답으로 받은 실제 저장값을 store 에 반영 — backend 가 안 받았으면 store 도 안 바뀜.
        const value = assignee ?? '';
        const updated = await projectApi.update(projectId, { assignee: value });
        set((s) => ({
          projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
        }));
      },

      setProjectExecutionAssignee: async (projectId, executionAssignee) => {
        const value = executionAssignee ?? '';
        const updated = await projectApi.update(projectId, { executionAssignee: value });
        set((s) => ({
          projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
        }));
      },

      setProjectPhase: async (projectId, phase) => {
        await projectApi.update(projectId, { phase });
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, phase } : p
          ),
        }));
      },

      setProjectRunStatus: async (projectId, runStatus) => {
        await projectApi.update(projectId, { runStatus });
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, runStatus } : p
          ),
        }));
      },
    }),
    {
      name: 'modernize-workspace',
      version: 10,
      // v9: 서버 연동 전환. localStorage 에는 activeSiteId / activeProjectId 만 영속.
      partialize: (state) => ({
        activeSiteId: state.activeSiteId,
        activeProjectId: state.activeProjectId,
      }),
    },
  ),
);
