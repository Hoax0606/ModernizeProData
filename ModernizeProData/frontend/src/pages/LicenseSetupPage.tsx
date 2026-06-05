import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { licenseApi } from '../api/license';
import { BrandName } from '../components/BrandName';
import { LanguageDropdown } from '../components/LanguageDropdown';
import { useT } from '../i18n';
import { useAuthStore } from '../store/auth';
import { useSettingsStore } from '../store/settings';
import { APP_VERSION } from '../lib/appVersion';

/**
 * First-boot license setup screen.
 *
 * 2026-05-30 — Edge 의 native file picker 사용 (HTML5 input type=file).
 * 옛 JavaFX WebView 의 prompt-handler trick 폐기.
 */
export function LicenseSetupPage() {
  const t = useT();
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  // Anonymous first-boot OR master only. A worker (admin role) that has
  // somehow landed here from a license-MISSING Coordinator should NOT be
  // able to apply a license file — that's master's job. Backend's
  // controller guard is the authority; this just keeps the UI honest.
  const canApply = !user || user.role === 'master';
  const [content, setContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onPick = () => {
    fileInputRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일 재선택 가능하도록.
    if (!file) return;
    try {
      const text = await file.text();
      setContent(text);
      setFileName(file.name);
      setError(null);
    } catch (err) {
      setError(t('licenseSetup.error.fileChooser', {
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      await licenseApi.initialSetup(content);
      nav('/login', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.code === 'LICENSE_INVALID_SIG'
            ? t('licenseSetup.error.invalidSig')
            : err.code === 'LICENSE_ALREADY_LOADED'
            ? t('licenseSetup.error.alreadyLoaded')
            : err.message,
        );
      } else {
        setError(t('licenseSetup.error.unknown', {
          message: err instanceof Error ? err.message : String(err),
        }));
      }
    } finally {
      setBusy(false);
    }
  };

  const loaded = content != null;

  if (!canApply) {
    return (
      <div style={styles.wrap}>
        <div style={styles.column}>
          <div style={styles.langBar}>
            <LanguageDropdown language={language} onChange={setLanguage} />
          </div>
          <div style={styles.brandBlock}>
            <img src="/mpd.png" alt="" width={56} height={56} style={styles.logo} />
            <div style={styles.title}><BrandName /></div>
          </div>
          <div style={styles.card}>
            <div style={styles.cardTitle}>{t('licenseSetup.title')}</div>
            <div style={styles.cardHint}>{t('licenseSetup.workerBlocked')}</div>
          </div>
          <div style={styles.footer}>
            © KS Info System Co., Ltd. <span style={styles.footerVersion}>v{APP_VERSION}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.column}>
        <div style={styles.langBar}>
          <LanguageDropdown language={language} onChange={setLanguage} />
        </div>
        <div style={styles.brandBlock}>
          <img src="/mpd.png" alt="" width={56} height={56} style={styles.logo} />
          <div style={styles.title}><BrandName /></div>
        </div>

        <form style={styles.card} onSubmit={onSubmit}>
          <div style={styles.cardTitle}>{t('licenseSetup.title')}</div>
          <div style={styles.cardHint}>{t('licenseSetup.hint')}</div>

          <div style={styles.label}>
            <span style={styles.labelText}>{t('licenseSetup.fileLabel')}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".lic,.json,application/json,text/plain"
              onChange={onFileChange}
              style={{ display: 'none' }}
            />
            <button type="button" onClick={onPick} style={styles.filePickerBtn}>
              <span style={loaded ? styles.fileNameSet : styles.fileNameEmpty}>
                {loaded
                  ? (fileName ?? t('licenseSetup.fileLoaded', { bytes: content!.length }))
                  : t('licenseSetup.pickFile')}
              </span>
              <span style={styles.fileBrowseTag}>{t('licenseSetup.browse')}</span>
            </button>
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button
            type="submit"
            disabled={!loaded || busy}
            style={{ ...styles.button, ...(!loaded || busy ? styles.buttonDisabled : {}) }}
          >
            {busy ? t('licenseSetup.applying') : t('licenseSetup.apply')}
          </button>

          {/* Re-enter 실수로 진입한 경우 빠져나갈 path — login 화면으로 복귀. */}
          <button
            type="button"
            onClick={() => nav('/login', { replace: true })}
            style={styles.cancelBtn}
          >
            {t('licenseSetup.back')}
          </button>
        </form>

        <div style={styles.footer}>
          © KS Info System Co., Ltd. <span style={styles.footerVersion}>v{APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    padding: 20,
  },
  column: {
    width: 420,
    maxWidth: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 22,
  },
  langBar: { width: '100%', display: 'flex', justifyContent: 'flex-end' },
  brandBlock: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 },
  logo: { display: 'block', marginBottom: 4 },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--text)', letterSpacing: -0.4 },
  card: {
    width: '100%',
    padding: 24,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--navy)' },
  cardHint: { fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6, marginTop: -6 },
  label: { display: 'flex', flexDirection: 'column', gap: 6 },
  labelText: { fontSize: 13, color: 'var(--text)', fontWeight: 600 },
  filePickerBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'var(--mono)',
  },
  fileNameEmpty: { color: 'var(--text-3)' },
  fileNameSet: {
    color: 'var(--text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 280,
  },
  fileBrowseTag: {
    fontSize: 11,
    color: 'var(--navy)',
    fontWeight: 600,
    padding: '2px 8px',
    border: '1px solid var(--navy)',
    borderRadius: 3,
    fontFamily: 'inherit',
  },
  button: {
    padding: '11px 12px',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    background: 'var(--navy)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6, cursor: 'wait' },
  cancelBtn: {
    padding: '9px 12px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel-2)',
    color: 'var(--text-2)',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: {
    padding: '8px 10px',
    background: 'var(--red-50)',
    color: 'var(--red)',
    border: '1px solid var(--red)',
    borderRadius: 4,
    fontSize: 12,
  },
  footer: {
    fontSize: 12,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 4,
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
  },
  footerVersion: { fontSize: 11, color: 'var(--text-4)' },
};
