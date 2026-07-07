import { create } from 'zustand';

/**
 * 페이지 간 일회성 UI 트리거.
 *
 * MappingPage 같은 화면이 AppShell 의 SiteSettingsModal 을 열도록 신호하기 위한 store.
 * 영속화 X — 모달이 열리는 순간 consume 후 null 로 리셋.
 */

export type SiteSettingsFocus = 'tobe-db' | 'asis-csv' | 'general' | undefined;

interface UiState {
  /** AppShell 이 polling — non-null 이면 모달을 열고 즉시 consume. */
  siteSettingsRequest: { focus?: SiteSettingsFocus } | null;
  requestOpenSiteSettings: (opts?: { focus?: SiteSettingsFocus }) => void;
  consumeSiteSettingsRequest: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  siteSettingsRequest: null,
  requestOpenSiteSettings: (opts) => set({ siteSettingsRequest: { focus: opts?.focus } }),
  consumeSiteSettingsRequest: () => set({ siteSettingsRequest: null }),
}));
