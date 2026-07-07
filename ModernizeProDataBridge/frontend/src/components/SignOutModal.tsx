import { useEffect } from 'react';
import { BrandName } from './BrandName';
import { useAuthStore, roleLabel } from '../store/auth';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 로그아웃 확인 화면 — prototype 의 SignOutScreen 패턴.
 * 풀스크린 오버레이 + 가운데 카드. Esc 로 취소.
 */
export function SignOutModal({ open, onCancel, onConfirm }: Props) {
  const t = useT();
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const role = roleLabel(user?.role);

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <img src="/mpd.png" alt="" width={48} height={48} style={styles.logo} />

        <div style={styles.title}>
          {t('signout.titleBefore')}<BrandName />{t('signout.titleAfter')}
        </div>

        <div style={styles.desc}>
          {t('signout.desc1')}<br />
          {t('signout.desc2')}
        </div>

        <div style={styles.identityRow}>
          <span>{t('signout.signedInAs')}</span>
          <span style={styles.identityValue}>{user?.username} · {role}</span>
        </div>

        <div style={styles.actions}>
          <button onClick={onCancel} style={styles.btnGhost}>{t('common.cancel')}</button>
          <button onClick={onConfirm} style={styles.btnPrimary} autoFocus>{t('signout.confirm')}</button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'var(--bg)',
    display: 'grid',
    placeItems: 'center',
    zIndex: 3000,
  },
  card: {
    width: 400,
    maxWidth: 'calc(100vw - 32px)',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 5,
    padding: '24px 24px 18px',
    boxShadow: '0 20px 60px rgba(10,20,18,0.15)',
  },
  logo: {
    display: 'block',
    margin: '0 auto 12px',
  },
  title: {
    textAlign: 'center',
    fontSize: 15,
    fontWeight: 600,
    marginBottom: 5,
    color: 'var(--text)',
  },
  desc: {
    textAlign: 'center',
    fontSize: 11.5,
    color: 'var(--text-2)',
    lineHeight: 1.55,
    fontFamily: 'var(--mono)',
  },
  identityRow: {
    marginTop: 14,
    padding: '8px 11px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    fontSize: 10.5,
    fontFamily: 'var(--mono)',
    color: 'var(--text-3)',
    display: 'flex',
    justifyContent: 'space-between',
  },
  identityValue: { color: 'var(--text)' },
  actions: { display: 'flex', gap: 8, marginTop: 16 },
  btnGhost: {
    flex: 1,
    height: 30,
    border: '1px solid var(--border-strong)',
    background: 'var(--panel)',
    color: 'var(--text)',
    borderRadius: 3,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  btnPrimary: {
    flex: 1,
    height: 30,
    border: '1px solid var(--navy)',
    background: 'var(--navy)',
    color: '#fff',
    borderRadius: 3,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
