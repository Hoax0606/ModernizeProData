import { api, unwrap, type ApiResponse } from './client';

export type LicenseStatus =
  | 'ACTIVE'
  | 'EXPIRING'
  | 'IN_GRACE'
  | 'READ_ONLY'
  | 'EXPIRED'
  | 'MISSING'
  | 'INVALID';

export interface LicenseDto {
  licenseId: string | null;
  customer: string | null;
  siteId: string | null;
  edition: string | null;
  features: string[];
  issuedAt: string | null;
  expiresAt: string | null;
  graceDays: number;
  daysRemaining: number;
  status: LicenseStatus;
}

export const licenseApi = {
  get: () => unwrap(api.get<ApiResponse<LicenseDto>>('/api/v1/license')),

  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return unwrap(
      api.post<ApiResponse<LicenseDto>>('/api/v1/license', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
    );
  },

  /** dev 전용 — 현재 라이선스 wipe (MISSING 상태로). */
  clear: () => unwrap(api.delete<ApiResponse<LicenseDto>>('/api/v1/license')),
};
