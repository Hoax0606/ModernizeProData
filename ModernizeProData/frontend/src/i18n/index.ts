import { ko, type TranslationKey } from './ko';
import { ja } from './ja';
import { en } from './en';
import { useSettingsStore, type Language } from '../store/settings';

const dict: Record<Language, Record<TranslationKey, string>> = { ko, ja, en };

/**
 * 현재 언어 기준 번역 hook.
 * 사용 예:
 *   const t = useT();
 *   t('solution.title');
 *   t('siteSettings.confirmTitle', { name: 'KDB' });  // → "'KDB' 사이트를 삭제합니다"
 */
export function useT() {
  const language = useSettingsStore((s) => s.language);
  return (key: TranslationKey, vars?: Record<string, string | number>) => {
    let str = dict[language][key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(`{${k}}`, String(v));
      }
    }
    return str;
  };
}

/** Language → 표시명. 드롭다운 등에서 사용. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  ko: '한국어',
  ja: '日本語',
  en: 'English',
};

export type { TranslationKey };
