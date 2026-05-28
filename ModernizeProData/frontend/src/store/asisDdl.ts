import { create } from 'zustand';
import { asisDdlApi, type DdlImport, type DdlSchema } from '../api/asisDdl';

/**
 * 프로젝트별 AS-IS DDL 스키마 캐시.
 * 인포트/조회/삭제는 백엔드 호출 후 본 store 의 캐시를 업데이트.
 */
interface AsisDdlState {
  /** projectId → schema (latestImport + tables/columns). */
  schemasByProject: Record<string, DdlSchema>;
  /** projectId → loading flag. */
  loadingByProject: Record<string, boolean>;
  /** projectId → 최근 에러 메시지 (UI 표시용). */
  errorByProject: Record<string, string | null>;

  fetch: (projectId: string) => Promise<DdlSchema>;
  import: (projectId: string, file: File) => Promise<DdlImport>;
  remove: (projectId: string) => Promise<void>;
  clear: (projectId: string) => void;
}

export const useAsisDdlStore = create<AsisDdlState>((set, get) => ({
  schemasByProject: {},
  loadingByProject: {},
  errorByProject: {},

  fetch: async (projectId) => {
    set((s) => ({
      loadingByProject: { ...s.loadingByProject, [projectId]: true },
      errorByProject: { ...s.errorByProject, [projectId]: null },
    }));
    try {
      const schema = await asisDdlApi.get(projectId);
      set((s) => ({
        schemasByProject: { ...s.schemasByProject, [projectId]: schema },
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
      }));
      return schema;
    } catch (e) {
      set((s) => ({
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
        errorByProject: {
          ...s.errorByProject,
          [projectId]: e instanceof Error ? e.message : String(e),
        },
      }));
      throw e;
    }
  },

  import: async (projectId, file) => {
    set((s) => ({
      loadingByProject: { ...s.loadingByProject, [projectId]: true },
      errorByProject: { ...s.errorByProject, [projectId]: null },
    }));
    try {
      const result = await asisDdlApi.import(projectId, file);
      // 인포트 성공 후 schema 도 재조회해 캐시 갱신
      const schema = await asisDdlApi.get(projectId);
      set((s) => ({
        schemasByProject: { ...s.schemasByProject, [projectId]: schema },
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
      }));
      return result;
    } catch (e) {
      set((s) => ({
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
        errorByProject: {
          ...s.errorByProject,
          [projectId]: e instanceof Error ? e.message : String(e),
        },
      }));
      throw e;
    }
  },

  remove: async (projectId) => {
    await asisDdlApi.delete(projectId);
    set((s) => {
      const { [projectId]: _, ...rest } = s.schemasByProject;
      return { schemasByProject: rest };
    });
  },

  clear: (projectId) => {
    set((s) => {
      const { [projectId]: _, ...rest } = s.schemasByProject;
      return { schemasByProject: rest };
    });
  },
}));
