import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth';
import { ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { useSettingsStore, type Language } from '../store/settings';
import { BrandName } from '../components/BrandName';
import { useT, LANGUAGE_LABELS } from '../i18n';

export function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessionConflict, setSessionConflict] = useState(false);
  const [evicting, setEvicting] = useState(false);
  // licenseChecked = false 동안엔 render 가 빈 화면. async probe 가 끝날
  // 때까지 LoginPage 폼을 *절대* 노출하지 않는다 → 어떤 race 가 있어도
  // license MISSING 상태에서 user 가 login 폼을 볼 가능성 차단.
  const [licenseChecked, setLicenseChecked] = useState(false);
  const [isWorkerMode, setIsWorkerMode] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  useEffect(() => {
    fetch('/api/v1/health/info?_=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.data?.licenseStatus === 'MISSING') {
          navigate('/license-setup', { replace: true });
          return;
        }
        if (d?.data?.mode === 'worker') setIsWorkerMode(true);
        setLicenseChecked(true);
      })
      .catch(() => setLicenseChecked(true));
  }, [navigate]);

  /** Worker 가 저장된 Coordinator URL 잊기 — backend 가 HKCU 삭제 후 process 종료.
      사용자 다시 launch 시 wizard 의 URL 입력 step 부터 재시작. */
  const handleForgetUrl = async () => {
    if (!window.confirm(t('login.forgetUrl.confirm'))) return;
    setForgetting(true);
    try {
      await fetch('/api/v1/worker-self/forget-url', { method: 'POST' });
      // backend 가 곧 종료. 사용자에게 안내 후 reload (response 후 그래도 종료 발생).
      alert(t('login.forgetUrl.done'));
    } catch (e) {
      console.error('[login] forget-url failed', e);
      alert(`Forget URL failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setForgetting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSessionConflict(false);
    setLoading(true);
    try {
      const res = await authApi.login({ username, password });
      setAuth(res.token, { username: res.username, role: res.role }, res.expiresAt, res.lastSignInAt);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'AUTH_USER_NOT_FOUND')                setError(t('login.error.userNotFound'));
        else if (err.code === 'AUTH_PASSWORD_INVALID')         setError(t('login.error.invalidPassword'));
        else if (err.code === 'AUTH_SESSION_ACTIVE_ELSEWHERE') setSessionConflict(true);
        else if (err.code === 'AUTH_LICENSE_BLOCKED')          setError(t('login.error.licenseBlocked'));
        else                                                    setError(err.message || t('login.error'));
      } else {
        setError((err as Error).message ?? t('login.error'));
      }
    } finally {
      setLoading(false);
    }
  };

  // "끊고 로그인" — 본인 비번 재인증으로 다른 곳 세션 무효화 후 자동 재로그인.
  const handleEvictAndLogin = async () => {
    setEvicting(true);
    setError(null);
    try {
      await authApi.forceSelfLogout(username, password);
      const res = await authApi.login({ username, password });
      setAuth(res.token, { username: res.username, role: res.role }, res.expiresAt, res.lastSignInAt);
      setSessionConflict(false);
      navigate('/');
    } catch (err) {
      setSessionConflict(false);
      if (err instanceof ApiError) {
        if (err.code === 'AUTH_PASSWORD_INVALID') setError(t('login.error.invalidPassword'));
        else                                       setError(err.message || t('login.error'));
      } else {
        setError((err as Error).message ?? t('login.error'));
      }
    } finally {
      setEvicting(false);
    }
  };

  const handleCancelEvict = () => {
    setSessionConflict(false);
    setError(null);
  };

  // License probe 가 끝나기 전엔 form 노출 금지.
  // backend 가 MISSING 이면 useEffect 가 location.replace('/license-setup')
  // 으로 이동 시켜버리므로 user 는 LoginPage 폼을 보지 못함.
  if (!licenseChecked) {
    return <div style={styles.wrap} />;
  }

  return (
    <div style={styles.wrap}>

      <div style={styles.column}>
        {/* 브랜드 — 로고 위, 타이틀 아래 */}
        <div style={styles.brandBlock}>
          <img src="/mpd.png" alt="" width={56} height={56} style={styles.logo} />
          <div style={styles.title}><BrandName /></div>
        </div>

        {/* 로그인 카드 */}
        <form style={styles.card} onSubmit={handleSubmit} autoComplete="off">
          <label style={styles.label}>
            <div style={styles.labelRow}>
              <span style={styles.labelText}>{t('login.username')}</span>
              <LanguageDropdown language={language} onChange={setLanguage} />
            </div>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={styles.input}
              autoFocus
              required
              autoComplete="off"
            />
          </label>

          <label style={styles.label}>
            <span style={styles.labelText}>{t('login.password')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              required
              autoComplete="new-password"
            />
          </label>

          {error && <div style={styles.error}>{error}</div>}

          {sessionConflict ? (
            <div style={styles.conflictBox}>
              <div style={styles.conflictHead}>
                <span style={styles.conflictIcon} aria-hidden>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="11" width="16" height="9" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.conflictTitle}>{t('login.conflict.title')}</div>
                  <div style={styles.conflictDesc}>{t('login.conflict.desc')}</div>
                </div>
              </div>
              <div style={styles.conflictActions}>
                <button
                  type="button"
                  onClick={handleCancelEvict}
                  disabled={evicting}
                  style={{ ...styles.conflictBtnGhost, ...(evicting ? styles.buttonDisabled : {}) }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleEvictAndLogin}
                  disabled={evicting}
                  style={{ ...styles.conflictBtnAmber, ...(evicting ? styles.buttonDisabled : {}) }}
                >
                  {evicting ? t('login.conflict.evicting') : t('login.conflict.evictAndLogin')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="submit"
              disabled={loading}
              style={{ ...styles.button, ...(loading ? styles.buttonDisabled : {}) }}
            >
              {loading ? t('login.loading') : t('login.submit')}
            </button>
          )}

          <div style={styles.hint}>
            {t('login.devHint.role')}: <code style={styles.code}>master</code> / <code style={styles.code}>admin</code> / <code style={styles.code}>viewer</code>
            &nbsp;·&nbsp; {t('login.devHint.password')} <code style={styles.code}>password</code>
          </div>

          {/* mode 별 보조 액션:
              - coordinator : License 재입력 → /license-setup 진입 (master 가 expired/invalid 교체).
              - worker      : URL 끊기 → backend 가 HKCU CoordinatorUrl 삭제 + 종료, 재실행 시
                              wizard 의 URL 입력 step 부터 재시작. */}
          {isWorkerMode ? (
            <button
              type="button"
              onClick={handleForgetUrl}
              disabled={forgetting}
              style={{ ...styles.linkBtn, ...(forgetting ? styles.buttonDisabled : {}) }}
            >
              {forgetting ? t('login.forgetUrl.busy') : t('login.forgetUrl')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => navigate('/license-setup')}
              style={styles.linkBtn}
            >
              {t('login.relicense')}
            </button>
          )}
        </form>

        {/* 푸터 */}
        <div style={styles.footer}>
          © KS Info System Co., Ltd. <span style={styles.footerVersion}>v1.0.0</span>
        </div>
      </div>
    </div>
  );
}

function LanguageDropdown({ language, onChange }: { language: Language; onChange: (l: Language) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const langs = Object.keys(LANGUAGE_LABELS) as Language[];

  return (
    <div ref={ref} style={dropdownStyles.wrap}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...dropdownStyles.trigger, ...(open ? dropdownStyles.triggerOpen : {}) }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{LANGUAGE_LABELS[language]}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform .12s' }}>
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>
      {open && (
        <div role="listbox" style={dropdownStyles.menu}>
          {langs.map((k) => {
            const active = k === language;
            return (
              <button
                key={k}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange(k); setOpen(false); }}
                style={{ ...dropdownStyles.item, ...(active ? dropdownStyles.itemActive : {}) }}
              >
                {LANGUAGE_LABELS[k]}
                {active && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6L5 9L10 3" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const dropdownStyles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', display: 'inline-block' },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 8px',
    border: '1px solid var(--border)',
    borderRadius: 3,
    background: 'var(--panel)',
    color: 'var(--text-2)',
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    lineHeight: 1.3,
  },
  triggerOpen: {
    borderColor: 'var(--navy)',
    color: 'var(--navy)',
    background: 'var(--navy-50)',
  },
  menu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    minWidth: 120,
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    boxShadow: '0 6px 18px rgba(12,31,27,0.12)',
    padding: 3,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    zIndex: 50,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 10px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text)',
    fontSize: 11.5,
    fontWeight: 500,
    cursor: 'pointer',
    borderRadius: 3,
    textAlign: 'left',
  },
  itemActive: {
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    fontWeight: 700,
  },
};

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    padding: 20,
    position: 'relative',
  },
  column: {
    width: 420,
    maxWidth: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 22,
  },
  brandBlock: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  logo: {
    display: 'block',
    marginBottom: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--text)',
    letterSpacing: -0.4,
  },
  card: {
    width: '100%',
    padding: 24,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    boxShadow: '0 1px 3px rgba(12,31,27,0.04)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  labelText: {
    fontSize: 13,
    color: 'var(--text)',
    fontWeight: 600,
  },
  input: {
    padding: '10px 12px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 13,
    fontFamily: 'var(--mono)',
    outline: 'none',
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
  conflictBox: {
    padding: 16,
    background: 'var(--panel)',
    border: '1px solid var(--navy)',
    borderLeft: '3px solid var(--navy)',
    borderRadius: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    boxShadow: '0 1px 3px rgba(14,114,104,0.08)',
  },
  conflictHead: { display: 'flex', alignItems: 'flex-start', gap: 12 },
  conflictIcon: {
    width: 32, height: 32,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    borderRadius: '50%',
    flexShrink: 0,
  },
  conflictTitle: {
    fontSize: 13.5,
    fontWeight: 700,
    color: 'var(--text)',
    marginBottom: 4,
  },
  conflictDesc: {
    fontSize: 12,
    color: 'var(--text-2)',
    lineHeight: 1.55,
  },
  conflictActions: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
  },
  conflictBtnGhost: {
    padding: '9px 14px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text-2)',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  conflictBtnAmber: {
    padding: '9px 14px',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    background: 'var(--navy)',
    color: '#fff',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  labelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  error: {
    padding: '8px 10px',
    background: 'var(--red-50)',
    color: 'var(--red)',
    border: '1px solid var(--red)',
    borderRadius: 4,
    fontSize: 12,
  },
  hint: {
    marginTop: 2,
    fontSize: 11,
    color: 'var(--text-3)',
    textAlign: 'center',
    lineHeight: 1.6,
    fontFamily: 'var(--mono)',
  },
  code: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    padding: '1px 5px',
    background: 'var(--panel-2)',
    borderRadius: 3,
    color: 'var(--text-2)',
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
  footerVersion: {
    fontSize: 11,
    color: 'var(--text-4)',
  },
  linkBtn: {
    marginTop: 4,
    padding: '8px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--navy)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
