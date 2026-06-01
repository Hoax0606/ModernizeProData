import { useEffect, useState } from 'react';
import { updatesApi, type UpdateStatusDto } from '../api/updates';
import { useT } from '../i18n';

type ApplyState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'success'; message: string } | { kind: 'error'; message: string };

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Auto-update modal. master only.
 *
 * 첫 mount = `/status` 가져와 표시 (이미 cache 된 정보).
 * `Check for updates` 버튼 = `/check` POST → manifest URL 능동 fetch + cache 갱신.
 * `Apply update` 버튼 = Step 4~5 까지는 비활성 (placeholder).
 */
export function UpdateModal({ open, onClose }: Props) {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>({ kind: 'idle' });

  useEffect(() => {
    if (!open) return;
    setError(null);
    updatesApi.status()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  const handleCheck = async () => {
    setBusy(true);
    setError(null);
    setApplyState({ kind: 'idle' });
    try {
      const s = await updatesApi.check();
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!window.confirm(t('update.applyConfirm'))) return;
    setApplyState({ kind: 'busy' });
    setError(null);
    try {
      const r = await updatesApi.apply();
      if (r.success) {
        setApplyState({ kind: 'success', message: r.message });
      } else {
        setApplyState({ kind: 'error', message: r.message });
      }
    } catch (e) {
      setApplyState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!open) return null;

  const current = status?.currentVersion ?? '—';
  const latest = status?.latestVersion ?? '—';
  const available = status?.updateAvailable === true;
  const checkTime = status?.lastCheckAt
    ? new Date(status.lastCheckAt).toLocaleString()
    : t('update.neverChecked');

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.title}>{t('update.title')}</div>
          <button onClick={onClose} style={styles.closeBtn} aria-label="Close">×</button>
        </div>

        <div style={styles.body}>
          <Row label={t('update.current')} value={current} />
          <Row label={t('update.latest')} value={latest}
               highlight={available ? 'navy' : undefined} />
          <Row label={t('update.lastCheck')} value={checkTime} />
          {status?.lastCheckStatus === 'failed' && status.lastCheckError && (
            <Row label={t('update.lastCheckError')} value={status.lastCheckError} highlight="red" />
          )}

          {available && status?.releaseNotes && (
            <div style={styles.notes}>
              <div style={styles.notesLabel}>{t('update.releaseNotes')}</div>
              <pre style={styles.notesBody}>{status.releaseNotes}</pre>
            </div>
          )}

          {error && <div style={styles.error}>{error}</div>}
        </div>

        {applyState.kind === 'success' && (
          <div style={styles.applySuccess}>{applyState.message} · {t('update.restartHint')}</div>
        )}
        {applyState.kind === 'error' && (
          <div style={styles.error}>{applyState.message}</div>
        )}

        <div style={styles.footer}>
          <button onClick={handleCheck} disabled={busy || applyState.kind === 'busy'} style={styles.checkBtn}>
            {busy ? t('update.checking') : t('update.checkBtn')}
          </button>
          {available && applyState.kind !== 'success' ? (
            <button
              onClick={handleApply}
              disabled={applyState.kind === 'busy'}
              style={applyState.kind === 'busy' ? styles.applyDisabled : styles.applyBtn}
            >
              {applyState.kind === 'busy' ? t('update.applying') : t('update.applyBtn')}
            </button>
          ) : applyState.kind === 'success' ? (
            <span style={styles.upToDate}>{t('update.restartHint')}</span>
          ) : (
            <span style={styles.upToDate}>{t('update.upToDate')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: 'navy' | 'red' }) {
  return (
    <div style={styles.row}>
      <div style={styles.rowLabel}>{label}</div>
      <div style={{ ...styles.rowValue, ...(highlight === 'navy' ? styles.rowNavy : {}), ...(highlight === 'red' ? styles.rowRed : {}) }}>
        {value}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0,
    background: 'rgba(15, 23, 42, 0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 4000,
  },
  dialog: {
    width: 460, maxWidth: '92%',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    boxShadow: '0 16px 40px rgba(12,31,27,0.18)',
    display: 'flex', flexDirection: 'column',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 18px',
    borderBottom: '1px solid var(--border)',
  },
  title: { fontSize: 14, fontWeight: 700, color: 'var(--text)' },
  closeBtn: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    color: 'var(--text-3)', fontSize: 18, lineHeight: 1, padding: '0 4px',
  },
  body: { padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 },
  rowLabel: { color: 'var(--text-3)', minWidth: 110 },
  rowValue: { color: 'var(--text)', fontFamily: 'var(--mono)', textAlign: 'right', flex: 1 },
  rowNavy: { color: 'var(--navy)', fontWeight: 700 },
  rowRed: { color: 'var(--red)' },
  notes: {
    marginTop: 6,
    padding: '8px 10px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 4,
  },
  notesLabel: { fontSize: 11, color: 'var(--text-3)', marginBottom: 4 },
  notesBody: {
    margin: 0,
    fontFamily: 'var(--mono)',
    fontSize: 11.5,
    whiteSpace: 'pre-wrap',
    color: 'var(--text-2)',
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
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 18px',
    borderTop: '1px solid var(--border)',
    gap: 8,
  },
  checkBtn: {
    padding: '8px 14px',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--navy)',
    fontSize: 12.5, fontWeight: 600,
    cursor: 'pointer',
  },
  applyBtn: {
    padding: '8px 14px',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    background: 'var(--navy)',
    color: '#fff',
    fontSize: 12.5, fontWeight: 600,
    cursor: 'pointer',
  },
  applyDisabled: {
    padding: '8px 14px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel-2)',
    color: 'var(--text-3)',
    fontSize: 12.5, fontWeight: 600,
    cursor: 'wait',
  },
  applySuccess: {
    margin: '8px 18px 0',
    padding: '8px 10px',
    background: 'var(--navy-50)',
    color: 'var(--navy)',
    border: '1px solid var(--navy)',
    borderRadius: 4,
    fontSize: 12,
  },
  upToDate: {
    fontSize: 12, color: 'var(--text-3)',
  },
};
