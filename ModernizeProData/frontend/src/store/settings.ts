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

interface SettingsState {
  theme: Theme;
  language: Language;
  notifications: boolean;
  notificationScope: NotificationScope;
  notificationRetention: string;
  /** External integrations master toggle — BE solution_settings.external_enabled の mirror.
   *  SchedulerPage が source of truth として BE から fetch する。store には optimistic な値が入る. */
  externalIntegrations: boolean;
  projectSort: ProjectSort;

  setTheme: (theme: Theme) => void;
  setLanguage: (language: Language) => void;
  setNotifications: (on: boolean) => void;
  setNotificationScope: (scope: NotificationScope) => void;
  setNotificationRetention: (retention: string) => void;
  setExternalIntegrations: (on: boolean) => void;
  setProjectSort: (sort: ProjectSort) => void;
}

/**
 * Solution settings 의 모든 값 — localStorage 에 영속.
 * 첫 화면 진입 시 theme/language 가 자동 적용.
 *
 * 注: 旧 ExternalConfig (cliPath / apiEndpoint / syslog / apiToken) は本ブランチで削除。
 *     token は BE 側で hash 管理されるので zustand には保持しない。
 *     CLI path / API endpoint / Syslog はメタ情報専用フィールドだったが機能ゼロのため撤去。
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
      projectSort: 'created-asc',

      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setNotifications: (on) => set({ notifications: on }),
      setNotificationScope: (scope) => set({ notificationScope: scope }),
      setNotificationRetention: (retention) => set({ notificationRetention: retention }),
      setExternalIntegrations: (on) => set({ externalIntegrations: on }),
      setProjectSort: (projectSort) => set({ projectSort }),
    }),
    { name: 'modernize-settings' },
  ),
);
