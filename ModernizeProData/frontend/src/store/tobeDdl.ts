import { create } from 'zustand';
import { tobeDdlApi } from '../api/tobeDdl';
import type { DdlImport, DdlSchema } from '../api/asisDdl';

/**
 * 프로젝트별 TO-BE DDL 스키마 캐시.
 * AsisDdlStore 와 같은 구조 — 다른 store 인 이유는 동시에 보유·표시되어야 하기 때문.
 */
interface TobeDdlState {
  schemasByProject: Record<string, DdlSchema>;
  loadingByProject: Record<string, boolean>;
  errorByProject: Record<string, string | null>;

  fetch: (projectId: string) => Promise<DdlSchema>;
  import: (projectId: string, file: File) => Promise<DdlImport>;
  remove: (projectId: string) => Promise<void>;
  clear: (projectId: string) => void;
}

export const useTobeDdlStore = create<TobeDdlState>((set) => ({
  schemasByProject: {},
  loadingByProject: {},
  errorByProject: {},

  fetch: async (projectId) => {
    set((s) => ({
      loadingByProject: { ...s.loadingByProject, [projectId]: true },
      errorByProject: { ...s.errorByProject, [projectId]: null },
    }));
    try {
      const schema = await tobeDdlApi.get(projectId);
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
      const result = await tobeDdlApi.import(projectId, file);
      const schema = await tobeDdlApi.get(projectId);
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
    await tobeDdlApi.delete(projectId);
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
