import { create } from 'zustand';
import { licenseApi, type LicenseDto, type LicenseStatus } from '../api/license';
import { resetLicenseLogoutFlag } from '../api/client';
import { useAuthStore } from './auth';

interface LicenseState {
  data: LicenseDto | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

/** Status values that should force-logout an already signed-in user so
 *  the master can re-upload a valid .lic from LoginPage. */
const LOGOUT_TRIGGER_STATUSES: ReadonlySet<LicenseStatus> = new Set([
  'EXPIRED',
  'INVALID',
  'MISSING',
]);

/**
 * 전역 라이선스 상태. AppShell 마운트 시 1회 + polling.
 * banner 표시 / write 차단 hint / 차단 상태에서 auto-logout 까지 담당.
 */
export const useLicenseStore = create<LicenseState>((set, get) => ({
  data: null,
  loaded: false,
  refresh: async () => {
    const prevStatus = get().data?.status;
    try {
      const d = await licenseApi.get();
      set({ data: d, loaded: true });
      // Transition-only: 이전 polling 에서 정상이었는데 이번에 차단으로 변한
      // 경우만 강제 logout. 첫 load 가 이미 MISSING 인 경우는 사용자가
      // dashboard 의 banner / Settings 에서 import 할 수 있게 그대로 둔다.
      const transitionedToBlock =
        !!prevStatus
        && !LOGOUT_TRIGGER_STATUSES.has(prevStatus)
        && LOGOUT_TRIGGER_STATUSES.has(d.status);
      if (transitionedToBlock && useAuthStore.getState().isAuthenticated()) {
        useAuthStore.getState().logout();
      }
      // Status 가 정상으로 회복되면 interceptor 의 single-shot flag 도 리셋
      // 해서 다음 사이클의 차단도 logout 으로 동작하게 한다.
      if (!LOGOUT_TRIGGER_STATUSES.has(d.status)) {
        resetLicenseLogoutFlag();
      }
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
