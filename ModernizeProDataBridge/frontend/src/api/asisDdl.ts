import { api, unwrap, type ApiResponse } from './client';

/* 백엔드 ApiResponse 와 매칭되는 타입들 */

export interface DdlImport {
  id: string;
  projectId: string;
  side: 'asis' | 'tobe';
  filename: string;
  fileSize: number;
  fileHash: string;
  dialect: string;
  status: string;
  tableCount: number;
  columnCount: number;
  errorMessage?: string | null;
  importedBy: string;
  importedAt: string;
}

export interface DdlTable {
  id: string;
  projectId: string;
  side: 'asis' | 'tobe';
  importId: string;
  schemaName: string;
  physicalName: string;
  logicalName?: string | null;
  tableComment?: string | null;
  ordinal: number;
}

export interface DdlColumn {
  id: string;
  tableId: string;
  ordinal: number;
  physicalName: string;
  logicalName?: string | null;
  dataTypeRaw: string;
  dataType: string;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  nullable: boolean;
  pkOrder?: number | null;
  defaultValue?: string | null;
  columnComment?: string | null;
}

export interface DdlTableWithColumns {
  table: DdlTable;
  columns: DdlColumn[];
}

export interface DdlSchema {
  latestImport: DdlImport | null;
  tables: DdlTableWithColumns[];
}

/* ── API client ───────────────────────────────────── */

export const asisDdlApi = {
  import: (projectId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return unwrap(
      api.post<ApiResponse<DdlImport>>(
        `/api/v1/projects/${projectId}/asis-ddl/import`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      ),
    );
  },

  get: (projectId: string) =>
    unwrap(api.get<ApiResponse<DdlSchema>>(`/api/v1/projects/${projectId}/asis-ddl`)),

  delete: (projectId: string) =>
    unwrap(api.delete<ApiResponse<void>>(`/api/v1/projects/${projectId}/asis-ddl`)),
};
