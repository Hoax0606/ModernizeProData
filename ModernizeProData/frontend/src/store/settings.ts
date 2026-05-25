import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark';
export type Language = 'ko' | 'ja' | 'en';

/**
 * 첫 부팅 시 OS locale 로 기본 언어 결정. localStorage 에 명시적으로
 * 저장된 값이 있으면 그게 우선 (persist middleware 처리).
 *   ko-* → 'ko' / ja-* → 'ja' / 그 외 → 'en'
 */
function detectInitialLanguage(): Language {
  if (typeof navigator === 'undefined') return 'en';
  const lang = (navigator.language || '').toLowerCase();
  if (lang.startsWith('ko')) return 'ko';
  if (lang.startsWith('ja')) return 'ja';
  return 'en';
}
export type ProjectSort = 'created-asc' | 'created-desc' | 'name-asc' | 'name-desc' | 'tables-desc';
export type NotificationScope = 'mine-only' | 'all-project';

export interface ExternalConfig {
  scheduler: string;
  cliPath: string;
  apiEndpoint: string;
  apiToken: string;
  syslog: string;
}

interface SettingsState {
  theme: Theme;
  language: Language;
  notifications: boolean;
  notificationScope: NotificationScope;
  notificationRetention: string;
  externalIntegrations: boolean;
  externalConfig: ExternalConfig;
  projectSort: ProjectSort;

  setTheme: (theme: Theme) => void;
  setLanguage: (language: Language) => void;
  setNotifications: (on: boolean) => void;
  setNotificationScope: (scope: NotificationScope) => void;
  setNotificationRetention: (retention: string) => void;
  setExternalIntegrations: (on: boolean) => void;
  setExternalConfig: (config: Partial<ExternalConfig>) => void;
  setProjectSort: (sort: ProjectSort) => void;
}

/**
 * Solution settings 의 모든 값 — localStorage 에 영속.
 * 첫 화면 진입 시 theme/language 가 자동 적용.
 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'light',
      language: detectInitialLanguage(),
      notifications: true,
      notificationScope: 'all-project',
      notificationRetention: '90 days',
      externalIntegrations: false,
      externalConfig: {
        scheduler: 'Control-M',
        cliPath: '/opt/modernize/bin/modernize',
        apiEndpoint: 'https://modernize.kdb.internal/api/v1/runs',
        apiToken: 'mig_****************_a9f3',
        syslog: 'syslog.kdb.internal:514 · facility local4',
      },
      projectSort: 'created-asc',

      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setNotifications: (on) => set({ notifications: on }),
      setNotificationScope: (scope) => set({ notificationScope: scope }),
      setNotificationRetention: (retention) => set({ notificationRetention: retention }),
      setExternalIntegrations: (on) => set({ externalIntegrations: on }),
      setExternalConfig: (config) =>
        set((s) => ({ externalConfig: { ...s.externalConfig, ...config } })),
      setProjectSort: (projectSort) => set({ projectSort }),
    }),
    { name: 'modernize-settings' },
  ),
);
