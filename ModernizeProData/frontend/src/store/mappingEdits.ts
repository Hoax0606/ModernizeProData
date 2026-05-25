import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * MappingPage 작업 중인 편집 상태 (사용자 흔적).
 * 페이지 떠나도/새로고침해도 살아남아야 하므로 localStorage persist.
 *
 * 모든 키의 최상위 차원은 projectId — 프로젝트 단위로 격리.
 *
 * 추후 mapping snapshot 저장 API 가 생기면, snapshot 생성 시 이 store 의
 * 내용을 백엔드로 보내고 store 는 비우는 식으로 동작.
 */

export type TableBindingEdit = {
  sources: Array<{
    alias: string;
    table: string;
    role: 'primary' | 'join' | 'union';
    joinType?: string;
    joinOn?: string;
    rows: number;
  }>;
  mode: 'join' | 'union';
  whereFilter?: string;
};

export type RowEdit = {
  savedSrc?: string[];
  savedRule?: string;
  savedDefault?: string;
  savedNotNull?: boolean;
  savedStrategy?: 'expression' | 'null' | 'default';
  /** 'imported' = CSV 임포트로 들어온 룰 (사용자 수정 전), 'manual' = row 편집기에서 사용자가 저장 */
  ruleOrigin?: 'imported' | 'manual';
};

interface MappingEditsState {
  /** projectId → (tobeInternalName → table binding edit) */
  tableBindingEdits: Record<string, Record<string, TableBindingEdit>>;
  /** projectId → (tobeInternalName → (targetColumnName → row edit)) */
  rowEdits: Record<string, Record<string, Record<string, RowEdit>>>;
  /** projectId → (asisTableName → (columnName → skipped flag)) */
  asisSkippedCols: Record<string, Record<string, Record<string, boolean>>>;

  setBindingEdit: (projectId: string, internalName: string, edit: TableBindingEdit) => void;
  /** 임포트 후 DB 의 bindings 로 해당 project 의 binding edits 전체 교체. */
  replaceBindingEdits: (projectId: string, edits: Record<string, TableBindingEdit>) => void;
  setRowEdit: (projectId: string, internalName: string, tgt: string, edit: RowEdit) => void;
  /** 임포트/hydrate 후 DB 의 mapping_rules 로 해당 project 의 row edits 전체 교체. */
  replaceRowEdits: (projectId: string, edits: Record<string, Record<string, RowEdit>>) => void;
  setAsisSkip: (projectId: string, tableName: string, colName: string, nextSkip: boolean) => void;
  clearProject: (projectId: string) => void;
}

export const useMappingEditsStore = create<MappingEditsState>()(
  persist(
    (set) => ({
      tableBindingEdits: {},
      rowEdits: {},
      asisSkippedCols: {},

      setBindingEdit: (projectId, internalName, edit) => set((s) => {
        const cur = s.tableBindingEdits[projectId] || {};
        return {
          tableBindingEdits: {
            ...s.tableBindingEdits,
            [projectId]: { ...cur, [internalName]: edit },
          },
        };
      }),

      replaceBindingEdits: (projectId, edits) => set((s) => ({
        tableBindingEdits: { ...s.tableBindingEdits, [projectId]: edits },
      })),

      setRowEdit: (projectId, internalName, tgt, edit) => set((s) => {
        const byProject = s.rowEdits[projectId] || {};
        const byTable = byProject[internalName] || {};
        return {
          rowEdits: {
            ...s.rowEdits,
            [projectId]: {
              ...byProject,
              [internalName]: { ...byTable, [tgt]: { ...byTable[tgt], ...edit } },
            },
          },
        };
      }),

      replaceRowEdits: (projectId, edits) => set((s) => ({
        rowEdits: { ...s.rowEdits, [projectId]: edits },
      })),

      setAsisSkip: (projectId, tableName, colName, nextSkip) => set((s) => {
        const byProject = s.asisSkippedCols[projectId] || {};
        const byTable = byProject[tableName] || {};
        return {
          asisSkippedCols: {
            ...s.asisSkippedCols,
            [projectId]: {
              ...byProject,
              [tableName]: { ...byTable, [colName]: nextSkip },
            },
          },
        };
      }),

      clearProject: (projectId) => set((s) => {
        const { [projectId]: _b, ...restBindings } = s.tableBindingEdits;
        const { [projectId]: _r, ...restRows } = s.rowEdits;
        const { [projectId]: _s, ...restSkip } = s.asisSkippedCols;
        return {
          tableBindingEdits: restBindings,
          rowEdits: restRows,
          asisSkippedCols: restSkip,
        };
      }),
    }),
    {
      name: 'mpd:mapping-edits',
      version: 1,
    },
  ),
);
