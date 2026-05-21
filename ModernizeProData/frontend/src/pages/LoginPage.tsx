import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth';
import { ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import { BrandName } from '../components/BrandName';
import { useT } from '../i18n';

export function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await authApi.login({ username, password });
      setAuth(res.token, { username: res.username, role: res.role }, res.expiresAt, res.lastSignInAt);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'AUTH_USER_NOT_FOUND')                setError(t('login.error.userNotFound'));
        else if (err.code === 'AUTH_PASSWORD_INVALID')         setError(t('login.error.invalidPassword'));
        else if (err.code === 'AUTH_SESSION_ACTIVE_ELSEWHERE') setError(t('login.error.sessionActiveElsewhere'));
        else                                                   setError(err.message || t('login.error'));
      } else {
        setError((err as Error).message ?? t('login.error'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.column}>
        {/* 브랜드 — 로고 위, 타이틀 아래 */}
        <div style={styles.brandBlock}>
          <img src="/mpd.png" alt="" width={56} height={56} style={styles.logo} />
          <div style={styles.title}><BrandName /></div>
        </div>

        {/* 로그인 카드 */}
        <form style={styles.card} onSubmit={handleSubmit}>
          <label style={styles.label}>
            <span style={styles.labelText}>{t('login.username')}</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={styles.input}
              autoFocus
              required
              autoComplete="username"
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
              autoComplete="current-password"
            />
          </label>

          {error && <div style={styles.error}>{error}</div>}

          <button
            type="submit"
            disabled={loading}
            style={{ ...styles.button, ...(loading ? styles.buttonDisabled : {}) }}
          >
            {loading ? t('login.loading') : t('login.submit')}
          </button>

          <div style={styles.hint}>
            {t('login.devHint.role')}: <code style={styles.code}>master</code> / <code style={styles.code}>admin</code> / <code style={styles.code}>viewer</code>
            &nbsp;·&nbsp; {t('login.devHint.password')} <code style={styles.code}>password</code>
          </div>
        </form>

        {/* 푸터 */}
        <div style={styles.footer}>
          © KS Info System Co., Ltd. <span style={styles.footerVersion}>v0.1.0-dev</span>
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
};
