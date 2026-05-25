import { useState } from 'react';
import { useT } from '../i18n';
import { fileDialogApi } from '../api/fileDialog';
import { ApiError } from '../api/client';

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
 * 백엔드가 headless 모드이거나 (서버 배포 등) 다이얼로그가 안 뜨는 환경에서는
 * 자동으로 window.prompt 로 폴백.
 */
export function CsvPathField({ value, onChange }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const fallbackPrompt = () => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const hint = isMac
      ? '예: /Users/me/migration/csv'
      : '예: D:\\migration\\csv 또는 \\\\server\\share\\csv';
    const seed = value && value.trim() ? value : (isMac ? '/Users/' : 'D:\\');
    const result = window.prompt(`AS-IS CSV 디렉터리의 절대경로를 입력하세요.\n${hint}`, seed);
    if (result !== null) {
      const trimmed = result.trim();
      if (trimmed) onChange(trimmed);
    }
  };

  const handleBrowse = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fileDialogApi.pickDirectory(value || undefined, 'AS-IS CSV 디렉터리 선택');
      if (!res.cancelled && res.path) onChange(res.path);
    } catch (e) {
      // Backend가 headless 거나 다이얼로그를 못 띄우면 prompt 로 폴백.
      if (e instanceof ApiError && (e.code === 'HEADLESS_BACKEND' || e.code === 'DIALOG_FAILED')) {
        fallbackPrompt();
      } else {
        console.warn('[CsvPathField] pickDirectory failed, falling back to prompt', e);
        fallbackPrompt();
      }
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
