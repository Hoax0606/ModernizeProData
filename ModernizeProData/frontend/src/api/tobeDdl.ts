import { api, unwrap, type ApiResponse } from './client';
import type { DdlImport, DdlSchema } from './asisDdl';

/* TO-BE DDL API client.
 * 모델 (DdlImport, DdlSchema 등) 은 asisDdl.ts 의 타입을 그대로 재사용 — 백엔드는 동일한
 * ddl_imports/ddl_tables/ddl_columns 테이블을 side 컬럼으로 구분해 사용한다. */

export const tobeDdlApi = {
  import: (projectId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return unwrap(
      api.post<ApiResponse<DdlImport>>(
        `/api/v1/projects/${projectId}/tobe-ddl/import`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      ),
    );
  },

  get: (projectId: string) =>
    unwrap(api.get<ApiResponse<DdlSchema>>(`/api/v1/projects/${projectId}/tobe-ddl`)),

  delete: (projectId: string) =>
    unwrap(api.delete<ApiResponse<void>>(`/api/v1/projects/${projectId}/tobe-ddl`)),
};
