import { create } from 'zustand';
import { licenseApi, type LicenseDto, type LicenseStatus } from '../api/license';

interface LicenseState {
  data: LicenseDto | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

/**
 * 전역 라이선스 상태. AppShell 마운트 시 1회 + 30분 polling.
 * banner 표시 / write 차단 hint 용도.
 */
export const useLicenseStore = create<LicenseState>((set) => ({
  data: null,
  loaded: false,
  refresh: async () => {
    try {
      const d = await licenseApi.get();
      set({ data: d, loaded: true });
    } catch {
      set({ data: null, loaded: true });
    }
  },
}));

/** banner / 차단 hint 가 필요한 상태인지 — ACTIVE 외 모두. */
export function shouldShowBanner(status: LicenseStatus | undefined): boolean {
  if (!status) return false;
  return status !== 'ACTIVE';
}

/** write 시 UI 사전 차단 권장 상태. backend 가 이미 403 으로 막지만 UX 개선용. */
export function isWriteBlocked(status: LicenseStatus | undefined): boolean {
  if (!status) return false;
  return status === 'READ_ONLY' || status === 'EXPIRED' || status === 'MISSING' || status === 'INVALID';
}
