import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark';
export type Language = 'ko' | 'ja' | 'en';

/**
 * 첫 부팅 시 기본 언어 결정. 우선순위:
 *   1. VITE_DEFAULT_LANG (빌드 시 박제 = MSI 설치 언어) — 첫 페인트부터 install 언어.
 *   2. OS locale (dev / 빌드값 없을 때) — ko-* → 'ko' / ja-* → 'ja' / 그 외 → 'en'.
 * 단 이 값은 사용자가 직접 언어를 고르기 전까지만 유효하고, 부팅 후 App 이 백엔드
 * defaultLanguage 로 applyDefaultLanguage() 보정한다 (languageExplicit=false 인 동안).
 */
function detectInitialLanguage(): Language {
  const built = (import.meta.env.VITE_DEFAULT_LANG || '').toLowerCase();
  if (built === 'ko' || built === 'ja' || built === 'en') return built as Language;
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
  /** 사용자가 드롭다운으로 언어를 직접 골랐는지. false 면 App 이 백엔드 install 언어로 보정 가능. */
  languageExplicit: boolean;
  notifications: boolean;
  notificationScope: NotificationScope;
  notificationRetention: string;
  /** 전 프로젝트 공통 이벤트 알림 on/off — eventKey → 활성 여부. 미설정 = true(켜짐).
   *  Solution Settings 의 "All-project notifications" 가 source. */
  notificationDefaults: Record<string, boolean>;
  /** External integrations master toggle — BE solution_settings.external_enabled の mirror.
   *  SchedulerPage が source of truth として BE から fetch する。store には optimistic な値が入る. */
  externalIntegrations: boolean;
  projectSort: ProjectSort;

  setTheme: (theme: Theme) => void;
  /** 사용자 명시 선택 — languageExplicit=true 로 잠가 이후 자동 보정을 막는다. */
  setLanguage: (language: Language) => void;
  /** 백엔드 install 언어 자동 보정 — 사용자가 아직 직접 안 골랐을 때(languageExplicit=false)만 적용. */
  applyDefaultLanguage: (language: Language) => void;
  setNotifications: (on: boolean) => void;
  setNotificationScope: (scope: NotificationScope) => void;
  setNotificationRetention: (retention: string) => void;
  setNotificationDefault: (eventKey: string, enabled: boolean) => void;
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
      languageExplicit: false,
      notifications: true,
      notificationScope: 'all-project',
      notificationRetention: '90 days',
      notificationDefaults: {},
      externalIntegrations: false,
      projectSort: 'created-asc',

      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language, languageExplicit: true }),
      applyDefaultLanguage: (language) =>
        set((s) => (s.languageExplicit ? {} : { language })),
      setNotifications: (on) => set({ notifications: on }),
      setNotificationScope: (scope) => set({ notificationScope: scope }),
      setNotificationRetention: (retention) => set({ notificationRetention: retention }),
      setNotificationDefault: (eventKey, enabled) =>
        set((s) => ({ notificationDefaults: { ...s.notificationDefaults, [eventKey]: enabled } })),
      setExternalIntegrations: (on) => set({ externalIntegrations: on }),
      setProjectSort: (projectSort) => set({ projectSort }),
    }),
    { name: 'modernize-settings' },
  ),
);
