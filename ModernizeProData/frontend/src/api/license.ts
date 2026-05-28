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
  /** v=2 license 는 이 PC 의 fingerprint 와 묶임. null = v=1 (PC 무관). */
  boundHardwareId: string | null;
  /** 이 PC 의 현재 hardware fingerprint. 항상 채워짐. */
  currentHardwareId: string;
  /** boundHardwareId 가 있고 currentHardwareId 와 다르면 true → status INVALID. */
  hardwareMismatch: boolean;
}

export interface FingerprintDto {
  fingerprint: string;
  shortDigest: string;
}

export const healthApi = {
  /** anonymous 가능. 로그인 전 first-boot 시 사용자에게 PC fingerprint 보여주려 호출. */
  fingerprint: () =>
    unwrap(api.get<ApiResponse<FingerprintDto>>('/api/v1/health/fingerprint')),
};

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

  /** Anonymous first-boot license upload. Only succeeds while no license
   *  is yet loaded on the Coordinator. Posts the file contents as a raw
   *  text/plain body — multipart/form-data NPEs JavaFX WebView's HTTP
   *  loader, and application/json would force Spring's Jackson converter
   *  to parse the body as JSON. */
  initialSetup: (content: string) =>
    unwrap(
      api.post<ApiResponse<LicenseDto>>('/api/v1/license/initial-setup', content, {
        headers: { 'Content-Type': 'text/plain' },
        transformRequest: [(d) => d],
      }),
    ),

  /** dev 전용 — 현재 라이선스 wipe (MISSING 상태로). */
  clear: () => unwrap(api.delete<ApiResponse<LicenseDto>>('/api/v1/license')),
};
