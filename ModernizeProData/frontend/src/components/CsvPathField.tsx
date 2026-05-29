import { useState } from 'react';
import { useT } from '../i18n';
import { fileDialogApi } from '../api/fileDialog';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

/**
 * CSV 디렉터리 입력 필드.
 *
 * Browse 버튼은 백엔드 (사용자 PC 에 같이 깔린 Coordinator) 에 요청해서
 * OS 네이티브 폴더 다이얼로그 (macOS Cocoa / Windows Explorer / Linux GTK)
 * 를 띄우고, 사용자가 고른 절대경로를 그대로 받아 input 에 채운다.
 *
 * 다이얼로그가 안 뜨는 환경(backend headless 등)에서는 조용히 실패하고
 * 사용자가 input 에 직접 타이핑하는 흐름으로 둔다. 브라우저 네이티브 prompt
 * 는 안 쓴다.
 */
export function CsvPathField({ value, onChange }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const handleBrowse = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fileDialogApi.pickDirectory(value || undefined, t('siteSettings.csvPathDialogTitle'));
      if (!res.cancelled && res.path) onChange(res.path);
    } catch (e) {
      // 사용자 요청: 브라우저 prompt 폴백 안 씀. 실패 시 input 직접 타이핑.
      console.warn('[CsvPathField] pickDirectory failed', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.row}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('siteSettings.csvPathPlaceholder')}
        style={styles.input}
        spellCheck={false}
      />
      <button
        type="button"
        onClick={handleBrowse}
        disabled={busy}
        style={busy ? { ...styles.btnGhost, opacity: 0.5, cursor: 'wait' } : styles.btnGhost}
      >
        {busy ? '…' : t('siteSettings.csvPathBrowse')}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', gap: 6 },
  input: {
    flex: 1,
    padding: '8px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 12,
    fontFamily: 'var(--mono)',
    outline: 'none',
  },
  btnGhost: {
    padding: '7px 12px',
    background: 'var(--panel)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-2)',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};
