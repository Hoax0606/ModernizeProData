import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { useAuthStore, roleLabel } from '../store/auth';
import { usersApi } from '../api/users';
import { ApiError } from '../api/client';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Account profile 모달 — 현재 로그인한 사용자의 로컬 계정 정보.
 */
function formatDt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function AccountProfileModal({ open, onClose }: Props) {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const lastSignInAt = useAuthStore((s) => s.lastSignInAt);
  const loginAt = useAuthStore((s) => s.loginAt);
  const [pwOpen, setPwOpen] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);

  const lastSignIn = formatDt(lastSignInAt);
  const sessionStart = loginAt ? `since ${formatDt(loginAt)}` : '—';
  const role = roleLabel(user?.role);

  const resetPwForm = () => {
    setCurPw(''); setNewPw(''); setConfirmPw('');
    setPwError(null); setPwSuccess(false);
  };
  const closePw = () => { setPwOpen(false); resetPwForm(); };

  // 모달을 열 때마다 비밀번호 변경 폼을 닫고 초기화한다 (이전 입력값 잔존 방지).
  useEffect(() => {
    if (open) { setPwOpen(false); resetPwForm(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canSubmitPw = !!curPw && !!newPw && newPw === confirmPw && newPw.length >= 4 && !pwSaving;

  const handlePwSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(null);
    if (newPw !== confirmPw) { setPwError(t('account.pw.error.mismatch')); return; }
    if (newPw.length < 4) { setPwError(t('account.pw.error.tooShort')); return; }
    setPwSaving(true);
    try {
      await usersApi.changeMyPassword(curPw, newPw);
      setPwSuccess(true);
      setCurPw(''); setNewPw(''); setConfirmPw('');
      setTimeout(() => { setPwOpen(false); setPwSuccess(false); }, 1200);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'CURRENT_PASSWORD_INVALID') setPwError(t('account.pw.error.invalid'));
        else if (err.code === 'PASSWORD_SAME')       setPwError(t('account.pw.error.same'));
        else                                          setPwError(err.message || t('account.pw.error.generic'));
      } else {
        setPwError(t('account.pw.error.generic'));
      }
    } finally {
      setPwSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={520} title={t('account.title')}>
      {/* 사용자 행 */}
      <div style={styles.userRow}>
        {(() => {
          const src = user?.role === 'master' ? '/master.png'
                    : user?.role === 'admin'  ? '/admin.jpg'
                    : null;
          if (src) return <img src={src} alt={user?.role} style={styles.avatarImg} />;
          return <div style={styles.avatar}>{user?.username?.[0]?.toUpperCase() ?? '?'}</div>;
        })()}
        <div>
          <div style={styles.name}>{user?.username}</div>
        </div>
      </div>

      <div style={styles.divider} />

      {/* 필드 */}
      <Field label={t('account.username')} value={user?.username ?? '—'} mono />
      <Field label={t('account.role')} value={role} mono />
      <Field label={t('account.lastSignIn')} value={lastSignIn} mono />
      <Field label={t('account.activeSession')} value={sessionStart} mono />

      {/* Password 섹션 */}
      <div style={styles.pwSection}>
        <div style={styles.pwHeader}>
          <div>
            <div style={styles.pwTitle}>{t('account.passwordLabel')}</div>
          </div>
          {!pwOpen ? (
            <button onClick={() => setPwOpen(true)} style={styles.pwBtn}>
              {t('account.changePassword')}
            </button>
          ) : (
            <button onClick={closePw} style={styles.pwBtnGhost} disabled={pwSaving}>
              {t('common.cancel')}
            </button>
          )}
        </div>

        {pwOpen && (
          <form onSubmit={handlePwSubmit} style={styles.pwForm}>
            <FormField label={t('account.currentPw')} type="password" value={curPw} onChange={setCurPw} autoFocus />
            <FormField label={t('account.newPw')} type="password" value={newPw} onChange={setNewPw} />
            <FormField label={t('account.confirmPw')} type="password" value={confirmPw} onChange={setConfirmPw} />
            {pwError && <div style={styles.pwErrorMsg}>{pwError}</div>}
            {pwSuccess && <div style={styles.pwSuccessMsg}>{t('account.pw.success')}</div>}
            <div style={styles.pwActions}>
              <button
                type="submit"
                style={{ ...styles.btnPrimary, ...(canSubmitPw ? {} : styles.btnDisabled) }}
                disabled={!canSubmitPw}
              >
                {pwSaving ? t('account.pw.saving') : t('common.save')}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>{label}</div>
      <div style={{ ...styles.fieldValue, ...(mono ? { fontFamily: 'var(--mono)' } : {}) }}>
        {value}
      </div>
    </div>
  );
}

function FormField({ label, type = 'text', value, onChange, autoFocus }: { label: string; type?: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label style={styles.formField}>
      <span style={styles.formLabel}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={styles.formInput}
        autoFocus={autoFocus}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
      />
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  userRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '4px 0 12px',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: 'var(--navy)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontSize: 18,
    fontWeight: 700,
    flexShrink: 0,
  },
  avatarImg: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    objectFit: 'contain',
    background: 'var(--panel-2)',
    flexShrink: 0,
  },
  name: { fontSize: 15, fontWeight: 700, color: 'var(--text)' },
  userSub: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)', marginTop: 2 },

  divider: { height: 1, background: 'var(--border)', margin: '4px 0 6px' },

  field: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 0',
    borderBottom: '1px dashed var(--border)',
  },
  fieldLabel: { width: 140, fontSize: 12, color: 'var(--text-3)', fontWeight: 500 },
  fieldValue: { flex: 1, fontSize: 12.5, color: 'var(--text)' },

  /* Password 섹션 */
  pwSection: {
    marginTop: 18,
    padding: '12px 14px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 5,
  },
  pwHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pwTitle: {
    fontSize: 12.5,
    fontWeight: 700,
    color: 'var(--text)',
  },
  pwMeta: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    marginTop: 3,
  },
  pwBtn: {
    padding: '6px 14px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  pwBtnGhost: {
    padding: '6px 14px',
    background: 'var(--panel)',
    color: 'var(--text-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },

  pwForm: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: '1px solid var(--border)',
  },
  pwNotImpl: {
    padding: '8px 10px',
    background: 'var(--amber-50)',
    border: '1px solid var(--amber)',
    color: 'var(--amber)',
    borderRadius: 4,
    fontSize: 11.5,
    marginBottom: 10,
    fontFamily: 'var(--mono)',
  },
  formField: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
  formLabel: { fontSize: 11, color: 'var(--text-3)', fontWeight: 500 },
  formInput: {
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    fontSize: 12.5,
    fontFamily: 'var(--mono)',
    outline: 'none',
  },
  pwErrorMsg: {
    padding: '6px 10px',
    background: 'var(--red-50)',
    border: '1px solid var(--red)',
    color: 'var(--red)',
    borderRadius: 4,
    fontSize: 11.5,
    marginBottom: 10,
  },
  pwSuccessMsg: {
    padding: '6px 10px',
    background: 'var(--green-50)',
    border: '1px solid var(--green)',
    color: 'var(--green)',
    borderRadius: 4,
    fontSize: 11.5,
    marginBottom: 10,
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  pwActions: { display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 },
  btnPrimary: {
    padding: '5px 14px',
    background: 'var(--navy)',
    color: '#fff',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
